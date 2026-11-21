import "server-only";

import type Stripe from "stripe";
import { resolveRefundedPaymentReview } from "@/lib/orders";
import { stripeAccountId } from "@/lib/payments/recovery";
import { assertSessionMatches, PaymentReviewError, stripeId } from "@/lib/payments/session-identity";
import { getOrder, type Order } from "@/lib/payments/store";
import { getStripe } from "@/lib/payments/stripe";

export const amountMismatch = "payment_amount_or_currency_mismatch";

export async function verifyMismatchRefund(stripe: Stripe, order: Order) {
  if (order.payment_method !== "card" || order.payment_review_reason !== amountMismatch ||
    order.paid_pence !== 0 || !order.payment_intent_id || !order.checkout_session_id ||
    !["awaiting_authorisation", "cancelled"].includes(order.fulfilment_status)) {
    throw new PaymentReviewError("This order no longer has a matching card payment review.");
  }
  if (order.stripe_checkout_account_id && await stripeAccountId(stripe) !== order.stripe_checkout_account_id) {
    throw new PaymentReviewError("The configured Stripe sandbox differs from the one used at checkout.");
  }
  const session = await stripe.checkout.sessions.retrieve(order.checkout_session_id);
  assertSessionMatches(order, session);
  if (stripeId(session.payment_intent) !== order.payment_intent_id) {
    throw new PaymentReviewError("The Stripe Checkout payment doesn’t match the order.");
  }
  const intent = await stripe.paymentIntents.retrieve(order.payment_intent_id, { expand: ["latest_charge"] });
  const charge = intent.latest_charge;
  if (intent.id !== order.payment_intent_id || intent.livemode !== false || intent.status !== "succeeded" ||
    intent.metadata?.edgey_order_id !== order.id || !/^[a-z]{3}$/.test(intent.currency) ||
    !Number.isSafeInteger(intent.amount_received) || intent.amount_received <= 0 ||
    (intent.amount_received === order.gross_pence && intent.currency.toUpperCase() === order.currency) ||
    !charge || typeof charge === "string" || !/^ch_[A-Za-z0-9]{1,197}$/.test(charge.id) ||
    charge.livemode !== false || !charge.paid || !charge.captured || stripeId(charge.payment_intent) !== intent.id ||
    charge.currency !== intent.currency || charge.amount_captured !== intent.amount_received) {
    throw new PaymentReviewError("Could not verify the original mismatched Stripe capture.");
  }
  if (!charge.refunded || charge.amount_refunded !== charge.amount_captured) {
    throw new PaymentReviewError("The charge hasn’t been fully refunded in Stripe.");
  }
  let amount = 0;
  let refundId: string | undefined;
  const seen = new Set<string>();
  for await (const refund of stripe.refunds.list({ charge: charge.id, limit: 100 })) {
    if (refund.status !== "succeeded") continue;
    if (!/^re_[A-Za-z0-9]{1,197}$/.test(refund.id) || seen.has(refund.id) || stripeId(refund.charge) !== charge.id ||
      stripeId(refund.payment_intent) !== intent.id || refund.currency !== charge.currency ||
      !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || refund.amount > charge.amount_captured - amount) {
      throw new PaymentReviewError("The Stripe refund records don’t match this capture.");
    }
    seen.add(refund.id);
    amount += refund.amount;
    if (!refundId || refund.id > refundId) refundId = refund.id;
  }
  if (!refundId || amount !== charge.amount_captured) {
    throw new PaymentReviewError("Successful Stripe refunds don’t yet cover the full charge.");
  }
  return { paymentIntentId: intent.id, refundId };
}

export async function resolveCardMismatchRefund(orderId: string, actorId: string) {
  const order = await getOrder(orderId);
  if (!order || order.payment_review_reason !== amountMismatch) {
    throw new PaymentReviewError("This order no longer has a matching card payment review.");
  }
  if (order.payment_review_refund_id) return;
  const proof = await verifyMismatchRefund(getStripe(), order);
  await resolveRefundedPaymentReview({ orderId, actorId, ...proof });
}
