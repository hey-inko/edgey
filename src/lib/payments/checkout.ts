import "server-only";
import type Stripe from "stripe";
import { createOrderWithReservations, type CreateOrderInput } from "@/lib/orders";
import type { Json } from "@/lib/supabase/database.types";
import { checkoutOrigin } from "./config";
import { bindVerifiedSession, findStripeSession, stripeRequestKey } from "./recovery";
import { assertSessionMatches, sessionAmountMatches } from "./session-identity";
import { stripeSessionParams } from "./session-params";
import { getOrderItems, paymentStore, type Order } from "./store";
import { getStripe } from "./stripe";

export type CardAttempt = Pick<CreateOrderInput, "attemptToken" | "contact" | "address"> & {
  lines: readonly { variantId: string; quantity: number }[];
};
type PriceAttempt = () => Promise<Omit<CreateOrderInput, "attemptToken" | "holdExpiresAt">>;

export class CheckoutUnavailableError extends Error {
  constructor(message: string, readonly attemptClosed = false) { super(message); }
}

export async function beginCardPayment(attempt: CardAttempt, priceAttempt: PriceAttempt) {
  const origin = checkoutOrigin();
  const db = paymentStore();
  const existing = async () => {
    const { data, error } = await db.from("orders").select("*")
      .eq("checkout_attempt_token", attempt.attemptToken).maybeSingle();
    if (error) throw error;
    return data;
  };
  const holdExpiresAt = new Date((Math.floor(Date.now() / 1_000) + 35 * 60) * 1_000).toISOString();
  let order = await existing();
  if (!order) {
    try {
      const priced = await priceAttempt();
      if (priced.totals.grossPence < 30 || priced.totals.grossPence > 99_999_999 ||
        priced.lines.length + Number(priced.totals.deliveryNetPence > 0) > 100) {
        throw new CheckoutUnavailableError("This order is outside the limits for online card payment.");
      }
      getStripe();
      await createOrderWithReservations({ ...priced, attemptToken: attempt.attemptToken, holdExpiresAt });
    } catch (error) {
      order = await existing();
      if (!order) throw error;
    }
  }
  order ??= await existing();
  if (!order) throw new Error("Could not load the reserved order.");
  const stripe = getStripe();

  const items = await getOrderItems(order.id);
  if (!matchesAttempt(order, attempt, items)) {
    throw new CheckoutUnavailableError("This payment attempt cannot be used for a changed order.");
  }
  if (order.payment_review_reason || order.fulfilment_status === "cancelled") {
    throw new CheckoutUnavailableError("This payment attempt is closed or under review.",
      order.fulfilment_status === "cancelled" && !order.payment_review_reason && order.paid_pence === 0);
  }

  let session: Stripe.Checkout.Session | null;
  if (order.checkout_session_id) {
    session = await stripe.checkout.sessions.retrieve(order.checkout_session_id);
  } else {
    if (!order.stripe_checkout_request) {
      const request = stripeSessionParams(order, items, origin);
      const { data, error } = await db.rpc("prepare_stripe_checkout", {
        p_order_id: order.id,
        p_request: JSON.parse(JSON.stringify(request)) as Json,
      });
      if (error) throw error;
      order = data;
    }
    if (order.checkout_session_id) {
      session = await stripe.checkout.sessions.retrieve(order.checkout_session_id);
    } else if (order.stripe_checkout_request && order.fulfilment_status === "awaiting_authorisation" &&
      !order.payment_review_reason) {
      session = await findStripeSession(stripe, order);
      if (!session && Date.parse(order.hold_expires_at) - Date.now() > 30 * 60_000 + 15_000) {
        try {
          session = await stripe.checkout.sessions.create(
            order.stripe_checkout_request as Stripe.Checkout.SessionCreateParams,
            { idempotencyKey: stripeRequestKey(order.id) },
          );
        } catch (error) {
          session = await findStripeSession(stripe, order);
          if (!session) throw error;
        }
      }
      if (session) await bindVerifiedSession(order, session);
    } else {
      session = null;
    }
  }

  if (!session) throw new CheckoutUnavailableError("Payment could not be resumed. Please try again shortly.");
  assertSessionMatches(order, session);
  if (session.status === "complete") {
    return { sessionId: session.id, url: `${origin}/checkout/success?session_id=${session.id}` };
  }
  if (session.status !== "open" || !session.url || session.payment_status !== "unpaid") {
    throw new CheckoutUnavailableError("This payment attempt is no longer open.");
  }
  const url = new URL(session.url);
  if (url.origin !== "https://checkout.stripe.com") throw new Error("Unexpected Stripe Checkout origin.");
  if (!sessionAmountMatches(order, session)) {
    const { error } = await db.from("orders")
      .update({ stripe_reconciliation_error: "Open Stripe Checkout amount or currency does not match the order." })
      .eq("id", order.id).eq("fulfilment_status", "awaiting_authorisation");
    if (error) throw error;
    throw new CheckoutUnavailableError("The payment amount could not be verified. This attempt needs review.");
  }
  return { sessionId: session.id, url: session.url };
}

function matchesAttempt(order: Order, { contact, address, lines }: CardAttempt, items: Awaited<ReturnType<typeof getOrderItems>>) {
  return order.buyer_id === null && order.payment_method === "card" &&
    order.email === contact.email && order.business_name === contact.businessName &&
    order.recipient_name === contact.recipientName && order.phone === (contact.phone ?? null) &&
    order.address_line1 === address.line1 && order.address_line2 === (address.line2 ?? null) &&
    order.address_town === address.town && order.address_region === (address.region ?? null) &&
    order.address_postcode === address.postcode && order.address_country === address.country &&
    items.length === lines.length && lines.every((line) =>
      items.some((item) => item.variant_id === line.variantId && item.quantity === line.quantity));
}
