import "server-only";
import type Stripe from "stripe";
import { applyStripeEvent, safePaymentFailure, stripeEventId } from "./events";
import { findStripeSession } from "./recovery";
import { PaymentReviewError } from "./session-identity";
import { reconcileSession } from "./settle";
import { paymentStore, type Order } from "./store";
import { getStripe } from "./stripe";

export async function replayStripeEvent(eventId: string) {
  if (!stripeEventId.test(eventId)) return "not_replayable";
  const { data, error } = await paymentStore().from("provider_events").select("*")
    .eq("provider", "stripe").eq("event_id", eventId).eq("state", "failed").maybeSingle();
  if (error) throw error;
  return data ? applyStripeEvent(getStripe(), data) : "not_replayable";
}

export async function reconcileStripePayments() {
  const stripe = getStripe();
  const db = paymentStore();
  const now = new Date();
  const nearExpiry = new Date(now.getTime() + 5 * 60_000).toISOString();
  const [events, orders] = await Promise.all([
    db.from("provider_events").select("*").eq("provider", "stripe").neq("state", "processed")
      .lte("stripe_replay_after", now.toISOString()).order("stripe_replay_after").limit(10),
    db.from("orders").select("*").eq("payment_method", "card").eq("fulfilment_status", "awaiting_authorisation")
      .lte("hold_expires_at", nearExpiry).lte("stripe_replay_after", now.toISOString())
      .order("stripe_replay_after").limit(10),
  ]);
  if (events.error) throw events.error;
  if (orders.error) throw orders.error;
  const eventWork = await Promise.allSettled(events.data.map((event) => applyStripeEvent(stripe, event)));
  const orderWork = await Promise.allSettled(orders.data.map((order) => reconcileOrder(stripe, order, now)));
  if ([...eventWork, ...orderWork].some((result) => result.status === "rejected")) {
    throw new Error("Stripe reconciliation could not persist one or more outcomes.");
  }
  return {
    eventsChecked: eventWork.length,
    ordersChecked: orderWork.length,
    unresolvedEvents: eventWork.filter((result) => result.status === "fulfilled" && result.value === "failed").length,
    unresolvedOrders: orderWork.filter((result) => result.status === "fulfilled" && result.value === "failed").length,
  };
}

async function reconcileOrder(stripe: Stripe, order: Order, now: Date) {
  const db = paymentStore();
  const pastExpiry = Date.parse(order.hold_expires_at) <= now.getTime();
  let issue: string | null = null;
  let updated = order;
  try {
    const session = await findStripeSession(stripe, order);
    if (session) {
      updated = await reconcileSession(stripe, order, session);
    } else if (!order.stripe_checkout_started_at && pastExpiry) {
      const { data, error } = await db.rpc("close_unstarted_stripe_checkout", { p_order_id: order.id });
      if (error) throw error;
      updated = data;
    }
    if (pastExpiry && updated.fulfilment_status === "awaiting_authorisation") {
      throw new PaymentReviewError(session
        ? "Stripe has not confirmed that this Checkout Session closed unpaid."
        : "Could not verify the result of creating this Stripe Checkout Session.");
    }
  } catch (error) {
    issue = safePaymentFailure(error);
  }
  const { error } = await db.from("orders").update({
    stripe_reconciliation_error: issue,
    stripe_replay_after: new Date(now.getTime() + 5 * 60_000).toISOString(),
  }).eq("id", order.id).eq("updated_at", updated.updated_at);
  if (error) throw error;
  return issue ? "failed" : "checked";
}
