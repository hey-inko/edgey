import "server-only";

import type Stripe from "stripe";
import { recordRefund } from "@/lib/orders";
import { stripeAccountId } from "./recovery";
import { assertSessionMatches, PaymentReviewError, sessionAmountMatches, stripeId } from "./session-identity";
import { getOrder, paymentStore, type Order } from "./store";
import { getStripe } from "./stripe";

export const lateCapture = "payment_after_reservation_released";
const providerRetryWindow = 23 * 60 * 60_000;

export function assertCardRefund(refund: Stripe.Refund, intent: Stripe.PaymentIntent, charge: Stripe.Charge) {
  if (!/^re_[A-Za-z0-9]{1,197}$/.test(refund.id) || stripeId(refund.payment_intent) !== intent.id ||
    stripeId(refund.charge) !== charge.id || refund.currency !== charge.currency ||
    !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || refund.amount > charge.amount_captured) {
    throw new PaymentReviewError("The Stripe refund does not match the captured card payment.");
  }
}

export async function refundCancelledCardOrder(orderId: string, actorId: string, allowCreate = true) {
  const db = paymentStore();
  const { data: role, error: roleError } = await db.from("staff_members").select("role")
    .eq("user_id", actorId).eq("role", "finance").maybeSingle();
  if (roleError) throw roleError;
  const order = role && await getOrder(orderId);
  if (!order || order.payment_method !== "card" || order.fulfilment_status !== "cancelled" ||
    order.dispatched_at || !order.payment_intent_id || !order.checkout_session_id || !order.paid_pence) {
    throw new PaymentReviewError("Only cancelled, undispatched orders with a captured card payment can be refunded here.");
  }
  const stripe = getStripe();
  const account = await stripeAccountId(stripe);
  if (order.stripe_checkout_account_id && account !== order.stripe_checkout_account_id) {
    throw new PaymentReviewError("The configured Stripe sandbox differs from the one used at checkout.");
  }
  const [session, intent] = await Promise.all([
    stripe.checkout.sessions.retrieve(order.checkout_session_id),
    stripe.paymentIntents.retrieve(order.payment_intent_id, { expand: ["latest_charge"] }),
  ]);
  assertSessionMatches(order, session);
  const charge = intent.latest_charge;
  if (!sessionAmountMatches(order, session) || stripeId(session.payment_intent) !== intent.id ||
    intent.id !== order.payment_intent_id || intent.livemode !== false || intent.status !== "succeeded" ||
    intent.metadata?.edgey_order_id !== order.id || intent.amount_received !== order.paid_pence ||
    intent.currency.toUpperCase() !== order.currency || !charge || typeof charge === "string" ||
    !/^ch_[A-Za-z0-9]{1,197}$/.test(charge.id) || charge.livemode !== false || !charge.paid || !charge.captured ||
    stripeId(charge.payment_intent) !== intent.id || charge.currency !== intent.currency ||
    charge.amount_captured !== intent.amount_received) {
    throw new PaymentReviewError("Could not verify the original Stripe Checkout capture.");
  }

  const listed = await stripe.refunds.list({ charge: charge.id, limit: 100 });
  if (listed.has_more) throw new PaymentReviewError("Too many refund records. Review this payment in Stripe.");
  const refunds = listed.data;
  const succeeded = refunds.filter((refund) => refund.status === "succeeded");
  const total = succeeded.reduce((sum, refund) => sum + refund.amount, 0);
  if (new Set(refunds.map(({ id }) => id)).size !== refunds.length || total > charge.amount_captured) {
    throw new PaymentReviewError("The Stripe refund records do not agree with the capture.");
  }
  for (const refund of refunds) assertCardRefund(refund, intent, charge);

  const apply = (refund: Stripe.Refund) => recordRefund({
    orderId, refundId: refund.id, paymentIntentId: intent.id, amountPence: refund.amount, currency: refund.currency,
  });
  let current: Pick<Order, "refunded_pence"> = order;
  for (const refund of succeeded) current = await apply(refund);
  if (current.refunded_pence === order.paid_pence && total === order.paid_pence) return "refunded";
  if (!allowCreate) throw new PaymentReviewError("Stripe hasn’t confirmed a full refund for this capture.");
  if (refunds.some(({ status }) => !["succeeded", "failed", "canceled"].includes(status ?? ""))) return "pending";
  if (total !== current.refunded_pence || total !== charge.amount_refunded) {
    throw new PaymentReviewError("The Stripe refund total is not yet consistent. Recheck before issuing any refund.");
  }
  if (account !== order.stripe_checkout_account_id) {
    throw new PaymentReviewError("There is no recorded Stripe account for this older order. Refund it in Stripe, then verify here.");
  }

  const amount = order.paid_pence - total;
  const chargeId = charge.id;
  async function prepare(previous?: { requestId: string; refundId: string }) {
    const { data, error } = await db.rpc("prepare_cancelled_card_refund", {
      p_order_id: orderId, p_actor_id: actorId, p_account_id: account, p_charge_id: chargeId,
      p_payment_intent_id: intent.id, p_amount_pence: amount,
      p_previous_request_id: previous?.requestId, p_failed_refund_id: previous?.refundId,
    }).maybeSingle();
    if (error) throw error;
    return data;
  }
  let request = await prepare();
  if (!request) return "refunded";
  const requestId = request.request_id;
  const previous = refunds.filter((refund) => refund.metadata?.edgey_refund_request_id === requestId);
  if (previous.length > 1) throw new PaymentReviewError("Multiple Stripe refunds refer to the same request. Review in Stripe.");
  if (previous[0]) {
    const refund = previous[0];
    if (refund.amount !== request.amount_pence || refund.metadata?.edgey_order_id !== orderId) {
      throw new PaymentReviewError("The Stripe refund does not match the recorded request.");
    }
    if (!["failed", "canceled"].includes(refund.status ?? "")) {
      throw new PaymentReviewError("The existing refund hasn’t settled the remaining amount. Review in Stripe before issuing another.");
    }
    request = await prepare({ requestId: request.request_id, refundId: refund.id });
    if (!request) return "refunded";
  }
  if (request.amount_pence !== amount || Date.now() - Date.parse(request.started_at) >= providerRetryWindow) {
    throw new PaymentReviewError("The earlier refund can’t be retried safely. Verify it in Stripe before making any adjustment.");
  }
  const refund = await stripe.refunds.create({
    charge: charge.id, amount, metadata: { edgey_order_id: orderId, edgey_refund_request_id: request.request_id },
  }, { idempotencyKey: `edgey:card-refund:v1:${request.request_id}` });
  assertCardRefund(refund, intent, charge);
  if (refund.amount !== amount || refund.metadata?.edgey_refund_request_id !== request.request_id ||
    refund.metadata.edgey_order_id !== orderId) {
    throw new PaymentReviewError("The Stripe refund response does not match the recorded request.");
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    throw new PaymentReviewError("Stripe did not complete the refund. Retry to verify its failure before issuing another.");
  }
  if (refund.status !== "succeeded") return "pending";
  return (await apply(refund)).refunded_pence === order.paid_pence ? "refunded" : "pending";
}
