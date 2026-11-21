import "server-only";
import type Stripe from "stripe";
import { applyStripeEvent, safePaymentFailure, stripeEventId } from "./events";
import { reconcileNet30Order } from "./net30";
import { closeUnboundCheckout, findStripeSession, stripeAccountId } from "./recovery";
import { PaymentReviewError } from "./session-identity";
import { reconcileSession } from "./settle";
import { getOrder, paymentStore, type Order } from "./store";
import { getStripe } from "./stripe";

export async function replayStripeEvent(eventId: string, expectedVersion?: string) {
  if (!stripeEventId.test(eventId)) return "not_replayable";
  const query = paymentStore().from("provider_events").select("*")
    .eq("provider", "stripe").eq("event_id", eventId).eq("state", "failed");
  if (expectedVersion) query.eq("updated_at", expectedVersion);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data ? applyStripeEvent(getStripe(), data) : "not_replayable";
}

export async function reconcileStripePayments() {
  const stripe = getStripe();
  const db = paymentStore();
  const now = new Date();
  const mature = new Date(now.getTime() - 2 * 60_000).toISOString();
  const [events, orders, tradeOrders] = await Promise.all([
    db.from("provider_events").select("*").eq("provider", "stripe").neq("state", "processed")
      .lte("stripe_replay_after", now.toISOString()).order("stripe_replay_after").limit(10),
    db.from("orders").select("*").eq("payment_method", "card").eq("fulfilment_status", "awaiting_authorisation")
      .lte("created_at", mature).lte("stripe_replay_after", now.toISOString())
      .order("stripe_replay_after").limit(10),
    db.from("orders").select("*").eq("payment_method", "net30")
      .or("fulfilment_status.eq.awaiting_authorisation,and(provider_invoice_id.not.is.null,or(payment_status.neq.voided,stripe_reconciliation_error.not.is.null))")
      .lte("created_at", mature).lte("stripe_replay_after", now.toISOString())
      .order("stripe_replay_after").limit(4),
  ]);
  if (events.error) throw events.error;
  if (orders.error) throw orders.error;
  if (tradeOrders.error) throw tradeOrders.error;
  const eventWork = await Promise.allSettled(events.data.map((event) => applyStripeEvent(stripe, event)));
  const orderWork = await Promise.allSettled(orders.data.map((order) => reconcileOrder(stripe, order, now)));
  const tradeWork = await Promise.allSettled(tradeOrders.data.map((order) => reconcileTradeOrder(stripe, order, now)));
  if ([...eventWork, ...orderWork, ...tradeWork].some((result) => result.status === "rejected")) {
    throw new Error("Stripe reconciliation could not persist one or more outcomes.");
  }
  return {
    eventsChecked: eventWork.length,
    ordersChecked: orderWork.length,
    tradeOrdersChecked: tradeWork.length,
    unresolvedEvents: eventWork.filter((result) => result.status === "fulfilled" && result.value === "failed").length,
    unresolvedOrders: orderWork.filter((result) => result.status === "fulfilled" && result.value === "failed").length,
    unresolvedTradeOrders: tradeWork.filter((result) => result.status === "fulfilled" && result.value === "failed").length,
  };
}

async function reconcileTradeOrder(stripe: Stripe, order: Order, now: Date) {
  let issue: string | null = null;
  let updated: Order;
  try {
    updated = await reconcileNet30Order(stripe, order);
  } catch (error) {
    issue = safePaymentFailure(error);
    updated = await getOrder(order.id) ?? order;
  }
  const interval = issue || updated.fulfilment_status === "awaiting_authorisation" ? 5
    : ["paid", "partially_refunded", "refunded"].includes(updated.payment_status) ? 60 * 24 : 60 * 6;
  const { error } = await paymentStore().from("orders").update({
    stripe_reconciliation_error: issue,
    stripe_replay_after: new Date(now.getTime() + interval * 60_000).toISOString(),
  }).eq("id", order.id).eq("updated_at", updated.updated_at);
  if (error) throw error;
  return issue ? "failed" : "checked";
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
    } else if (pastExpiry) {
      updated = await closeUnboundCheckout(order, order.stripe_checkout_started_at ? await stripeAccountId(stripe) : undefined);
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
