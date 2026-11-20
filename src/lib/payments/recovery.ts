import "server-only";
import type Stripe from "stripe";
import { bindCheckoutSession } from "@/lib/orders";
import { assertSessionMatches, PaymentReviewError } from "./session-identity";
import { paymentStore, type Order } from "./store";

export const stripeRequestKey = (orderId: string) => `edgey:checkout:v1:${orderId}`;

const stripeAccounts = new WeakMap<Stripe, Promise<string>>();
export function stripeAccountId(stripe: Stripe) {
  let account = stripeAccounts.get(stripe);
  if (!account) {
    account = stripe.accounts.retrieveCurrent().then(({ id }) => id).catch((error: unknown) => {
      stripeAccounts.delete(stripe);
      throw error;
    });
    stripeAccounts.set(stripe, account);
  }
  return account;
}

export async function closeUnboundCheckout(order: Order, accountId?: string, closeNow = false) {
  const { data, error } = await paymentStore().rpc("close_unbound_stripe_checkout", {
    p_order_id: order.id, p_account_id: accountId, p_close_now: closeNow,
  });
  if (error) throw error;
  return data;
}

export async function bindVerifiedSession(order: Order, session: Stripe.Checkout.Session) {
  assertSessionMatches(order, session);
  return bindCheckoutSession({
    orderId: order.id,
    sessionId: session.id,
    expiresAt: new Date(session.expires_at * 1_000).toISOString(),
  });
}

export async function findStripeSession(stripe: Stripe, order: Order, paymentIntentId?: string) {
  if (order.checkout_session_id) return stripe.checkout.sessions.retrieve(order.checkout_session_id);
  if (!order.stripe_checkout_started_at && !paymentIntentId) return null;
  if (order.stripe_checkout_account_id && await stripeAccountId(stripe) !== order.stripe_checkout_account_id) {
    throw new PaymentReviewError("The configured Stripe sandbox differs from the one used for this order.");
  }
  const list = paymentIntentId ? { payment_intent: paymentIntentId } : {
    created: {
      gte: Math.floor(Date.parse(order.stripe_checkout_started_at!) / 1_000) - 60,
      lte: Math.floor(Date.parse(order.hold_expires_at) / 1_000),
    },
  };
  let match: Stripe.Checkout.Session | null = null;
  let startingAfter: string | undefined;
  for (let page = 0; page < 5; page++) {
    const sessions = await stripe.checkout.sessions.list({ ...list, limit: 100, starting_after: startingAfter });
    for (const session of sessions.data) {
      if (session.metadata?.edgey_order_id !== order.id && session.client_reference_id !== order.id) continue;
      assertSessionMatches(order, session);
      if (match) throw new PaymentReviewError("Multiple Stripe Checkout Sessions match the order.");
      match = session;
    }
    if (!sessions.has_more) return match;
    startingAfter = sessions.data.at(-1)?.id;
    if (!startingAfter) break;
  }
  throw new PaymentReviewError("Stripe Checkout lookup did not cover the whole recovery window.");
}
