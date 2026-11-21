import "server-only";
import type Stripe from "stripe";
import { promiseForReservedOrder } from "@/lib/delivery/terms";
import { confirmPayment, releaseReservation } from "@/lib/orders";
import { bindVerifiedSession } from "./recovery";
import { assertSessionMatches, PaymentReviewError, sessionAmountMatches, stripeId } from "./session-identity";
import { paymentStore, type Order } from "./store";

export async function reconcileSession(
  stripe: Stripe,
  order: Order,
  session: Stripe.Checkout.Session,
  invoiceId?: string,
  asyncFailed = false,
): Promise<Order> {
  assertSessionMatches(order, session);
  const paymentIntentId = stripeId(session.payment_intent);
  const intent = paymentIntentId ? await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ["latest_charge"],
  }) : null;
  if (intent && (intent.id !== paymentIntentId || intent.livemode || intent.metadata.edgey_order_id !== order.id)) {
    throw new PaymentReviewError("Stripe PaymentIntent identity does not match the order.");
  }
  if (intent?.status === "succeeded") {
    const charge = intent.latest_charge;
    if (!charge || typeof charge === "string" || !charge.paid || !charge.captured || charge.livemode ||
      stripeId(charge.payment_intent) !== intent.id || charge.currency !== intent.currency ||
      charge.amount_captured !== intent.amount_received || !Number.isInteger(charge.created) || charge.created <= 0) {
      throw new PaymentReviewError("Stripe did not return a verified captured charge.");
    }
    const paidAt = new Date(charge.created * 1_000).toISOString();
    const amountPence = intent.amount_received;
    const currency = intent.currency;
    const moneyMismatch = amountPence !== order.gross_pence || currency.toUpperCase() !== order.currency;
    if (!moneyMismatch && (session.amount_total !== amountPence || session.currency !== currency)) {
      throw new PaymentReviewError("Stripe Checkout and the captured charge disagree on amount or currency.");
    }
    const attachedInvoice = stripeId(session.invoice);
    if (invoiceId && attachedInvoice !== invoiceId) {
      throw new PaymentReviewError("Stripe Invoice is not linked to the verified Checkout Session.");
    }
    const needsPromise = !moneyMismatch && !order.authorised_at && order.fulfilment_status === "awaiting_authorisation";
    const promise = needsPromise ? promiseForReservedOrder(order, paidAt) : null;
    if (needsPromise && !promise) {
      throw new PaymentReviewError("Could not compute the delivery promise from the captured payment.");
    }
    const updated = await confirmPayment({
      orderId: order.id,
      sessionId: session.id,
      paymentIntentId: intent.id,
      amountPence,
      currency,
      invoiceId: attachedInvoice,
      paidAt,
      promise: promise ?? {
        dispatchDate: order.promised_dispatch_date,
        deliveryDate: order.estimated_delivery_date,
      },
    });
    if (updated.payment_review_reason === "payment_amount_or_currency_mismatch" && !updated.payment_review_refund_id) {
      throw new PaymentReviewError("Captured Stripe amount or currency does not match the order.");
    }
    return clearReconciliationError({ ...order, ...updated });
  }

  const potentiallyPayable = intent && !["canceled", "requires_payment_method"].includes(intent.status);
  if (session.payment_status !== "unpaid") {
    throw new PaymentReviewError("Stripe Checkout reports payment without a confirmed capture.");
  }
  if ((!potentiallyPayable && session.status === "expired") ||
    (session.status === "complete" && !potentiallyPayable &&
      (intent?.status === "canceled" || (asyncFailed && intent?.status === "requires_payment_method")))) {
    const updated = await releaseReservation({
      orderId: order.id,
      sessionId: session.id,
      operationKey: `stripe-closed:${session.id}`,
      reason: "closed",
    });
    return clearReconciliationError({ ...order, ...updated });
  }

  if (session.status === "open" && !sessionAmountMatches(order, session)) {
    throw new PaymentReviewError("Open Stripe Checkout amount or currency does not match the order.");
  }
  if (!order.checkout_session_id && order.fulfilment_status === "awaiting_authorisation") {
    return { ...order, ...await bindVerifiedSession(order, session) };
  }
  return order;
}

async function clearReconciliationError(order: Order): Promise<Order> {
  if (!order.stripe_reconciliation_error || order.fulfilment_status === "awaiting_authorisation") return order;
  const { data, error } = await paymentStore().from("orders").update({ stripe_reconciliation_error: null })
    .eq("id", order.id).eq("updated_at", order.updated_at).select("*").maybeSingle();
  if (error) throw error;
  return data ?? order;
}
