import "server-only";
import type Stripe from "stripe";
import { markProviderEvent, recordProviderEvent, recordRefund } from "@/lib/orders";
import { applyTradeInvoiceEvent, findTradeInvoiceOrder, releaseTerminalInvoice } from "./net30-ledger";
import { readTradeInvoice, verifyStripeAccount } from "./net30-provider";
import { findStripeSession } from "./recovery";
import { checkoutSessionId, orderId, PaymentReviewError, stripeId } from "./session-identity";
import { reconcileSession } from "./settle";
import { getOrder, paymentStore, type ProviderEvent } from "./store";

export const STRIPE_EVENT_TYPES = [
  "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed", "checkout.session.expired",
  "invoice.finalized", "invoice.sent", "invoice.paid", "invoice.payment_succeeded", "invoice_payment.paid",
  "invoice.voided", "invoice.deleted", "invoice.marked_uncollectible", "invoice.overdue",
  "credit_note.created", "credit_note.voided",
  "charge.refunded", "refund.created", "refund.updated", "refund.failed",
] as const;
const eventTypes = new Set<string>(STRIPE_EVENT_TYPES);
export const stripeEventId = /^evt_[A-Za-z0-9_]{1,190}$/;

export async function acceptStripeEvent(stripe: Stripe, event: Stripe.Event) {
  const objectId = (event.data.object as { id?: unknown }).id;
  const stored = await recordProviderEvent({
    provider: "stripe",
    eventId: event.id,
    eventType: event.type,
    payload: { objectId: typeof objectId === "string" && /^[A-Za-z0-9_]{1,200}$/.test(objectId) ? objectId : null },
  });
  return applyStripeEvent(stripe, stored);
}

export async function applyStripeEvent(stripe: Stripe, event: Pick<ProviderEvent, "event_id" | "event_type" | "payload" | "state">) {
  if (event.state === "processed") return "processed";
  const identity = { provider: "stripe", eventId: event.event_id };
  try {
    if (eventTypes.has(event.event_type)) {
      const payload = event.payload;
      const objectId = payload && typeof payload === "object" && !Array.isArray(payload) && payload.objectId;
      if (typeof objectId !== "string") throw new PaymentReviewError("Stripe event is missing its resource ID.");
      await applyFinancialEffect(stripe, event.event_type, objectId);
    }
  } catch (error) {
    const result = await markProviderEvent({
      ...identity,
      state: "failed",
      error: safePaymentFailure(error),
    });
    if (result.state === "processed") return "processed";
    const { error: updateError } = await paymentStore().from("provider_events")
      .update({ stripe_replay_after: new Date(Date.now() + 5 * 60_000).toISOString() })
      .eq("provider", "stripe").eq("event_id", event.event_id).eq("state", "failed");
    if (updateError) throw updateError;
    return "failed";
  }
  await markProviderEvent({ ...identity, state: "processed" });
  return "processed";
}

export function safePaymentFailure(error: unknown) {
  return error instanceof PaymentReviewError
    ? error.message
    : "Could not verify or apply Stripe state. Retry or review the provider record.";
}

async function knownOrder(reference: string) {
  if (!orderId.test(reference)) throw new PaymentReviewError("Invalid Edgey order identity on Stripe.");
  const order = await getOrder(reference);
  if (!order) throw new PaymentReviewError("Stripe references an Edgey order that does not exist.");
  return order;
}

async function applyFinancialEffect(stripe: Stripe, type: string, objectId: string) {
  if (type.startsWith("checkout.session.")) {
    if (!checkoutSessionId.test(objectId)) throw new PaymentReviewError("Invalid Stripe Checkout Session ID.");
    const session = await stripe.checkout.sessions.retrieve(objectId);
    const reference = session.metadata?.edgey_order_id ?? session.client_reference_id;
    if (!reference) return;
    const order = await knownOrder(reference);
    const current = await reconcileSession(stripe, order, session, undefined, type === "checkout.session.async_payment_failed");
    if ((type === "checkout.session.async_payment_succeeded" ||
      (type === "checkout.session.completed" && session.payment_status === "paid")) &&
      !current.paid_pence && !current.payment_review_refund_id) {
      throw new PaymentReviewError("Stripe reported success before its captured charge could be verified.");
    }
    if ((type === "checkout.session.expired" || type === "checkout.session.async_payment_failed") &&
      current.fulfilment_status === "awaiting_authorisation" && !current.paid_pence) {
      throw new PaymentReviewError("Stripe has not yet confirmed that this Checkout Session closed unpaid.");
    }
    return;
  }
  if (type.startsWith("invoice.") || type === "invoice_payment.paid" || type.startsWith("credit_note.")) {
    let id = objectId;
    if (type === "invoice_payment.paid") {
      if (!/^inpay_[A-Za-z0-9]+$/.test(objectId)) throw new PaymentReviewError("Invalid Stripe Invoice Payment ID.");
      const payment = await stripe.invoicePayments.retrieve(objectId);
      if (payment.id !== objectId || payment.livemode !== false || payment.status !== "paid") {
        throw new PaymentReviewError("Stripe has not confirmed the referenced invoice payment.");
      }
      id = stripeId(payment.invoice) ?? "";
    } else if (type.startsWith("credit_note.")) {
      if (!/^cn_[A-Za-z0-9]+$/.test(objectId)) throw new PaymentReviewError("Invalid Stripe Credit Note ID.");
      const note = await stripe.creditNotes.retrieve(objectId);
      if (note.id !== objectId || note.livemode !== false) throw new PaymentReviewError("Stripe credit note identity did not match.");
      id = stripeId(note.invoice) ?? "";
    }
    const invoice = await readTradeInvoice(stripe, id);
    if (!invoice || invoice.deleted) {
      const { data, error } = await paymentStore().from("orders").select("*")
        .eq("stripe_net30_invoice_id", id).eq("payment_method", "net30").maybeSingle();
      if (error) throw error;
      if (data && type === "invoice.deleted") {
        await verifyStripeAccount(stripe, data);
        await releaseTerminalInvoice(data, id, "deleted");
      } else if (type !== "invoice.deleted") {
        throw new PaymentReviewError("Stripe did not return the referenced invoice.");
      }
      return;
    }
    const order = await findTradeInvoiceOrder(invoice);
    if (!order) return;
    if (order.payment_method === "net30") {
      await applyTradeInvoiceEvent(stripe, order, invoice, type === "invoice.sent");
      return;
    }
    if (type !== "invoice.finalized") return;
    const session = await findStripeSession(stripe, order);
    if (!session || stripeId(session.invoice) !== invoice.id) {
      throw new PaymentReviewError("Stripe Invoice is not yet linked to the verified Checkout Session.");
    }
    const current = await reconcileSession(stripe, order, session, invoice.id);
    if (current.provider_invoice_id !== invoice.id && !current.payment_review_refund_id) {
      throw new PaymentReviewError("Stripe Invoice is awaiting verified payment.");
    }
    return;
  }

  if (type === "charge.refunded") {
    if (!/^ch_[A-Za-z0-9]+$/.test(objectId)) throw new PaymentReviewError("Invalid Stripe Charge ID.");
    const charge = await stripe.charges.retrieve(objectId);
    if (charge.livemode) return;
    const intentId = stripeId(charge.payment_intent);
    if (!intentId) return;
    const intent = await stripe.paymentIntents.retrieve(intentId);
    if (!intent.metadata.edgey_order_id) return reconcileTradeRefundEvent(stripe, intent);
    const order = await knownOrder(intent.metadata.edgey_order_id);
    if (order.payment_method === "net30") return reconcileTradeRefundEvent(stripe, intent);
    for await (const refund of stripe.refunds.list({ charge: charge.id, limit: 100 })) {
      await applyRefund(stripe, refund, intent);
    }
  } else {
    if (!/^re_[A-Za-z0-9]+$/.test(objectId)) throw new PaymentReviewError("Invalid Stripe Refund ID.");
    const refund = await stripe.refunds.retrieve(objectId);
    if (refund.status !== "succeeded") return;
    const intentId = stripeId(refund.payment_intent);
    if (!intentId) return;
    const intent = await stripe.paymentIntents.retrieve(intentId);
    await applyRefund(stripe, refund, intent);
  }
}

async function applyRefund(stripe: Stripe, refund: Stripe.Refund, intent: Stripe.PaymentIntent) {
  if (refund.status !== "succeeded" || intent.livemode) return;
  if (!intent.metadata.edgey_order_id) return reconcileTradeRefundEvent(stripe, intent);
  const order = await knownOrder(intent.metadata.edgey_order_id);
  if (stripeId(refund.payment_intent) !== intent.id) throw new PaymentReviewError("Stripe Refund does not match the order payment.");
  if (order.payment_method === "net30") return reconcileTradeRefundEvent(stripe, intent);
  const session = await findStripeSession(stripe, order, intent.id);
  if (!session || stripeId(session.payment_intent) !== intent.id) {
    throw new PaymentReviewError("Could not match the refunded Stripe payment to its Checkout Session.");
  }
  const current = await reconcileSession(stripe, order, session);
  if (current.payment_review_refund_id) return;
  if (!current.paid_pence) throw new PaymentReviewError("The refunded Stripe payment is awaiting capture reconciliation.");
  await recordRefund({
    orderId: order.id,
    refundId: refund.id,
    paymentIntentId: intent.id,
    amountPence: refund.amount,
    currency: refund.currency,
  });
}

async function reconcileTradeRefundEvent(stripe: Stripe, intent: Stripe.PaymentIntent) {
  if (intent.livemode !== false) return;
  const payments = await stripe.invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: intent.id }, status: "paid", limit: 100,
  });
  if (payments.has_more) throw new PaymentReviewError("Too many invoice allocations to reconcile a Stripe refund.");
  for (const id of new Set(payments.data.map((payment) => stripeId(payment.invoice)))) {
    if (!id) throw new PaymentReviewError("A refund has no identifiable Stripe invoice allocation.");
    const invoice = await readTradeInvoice(stripe, id);
    if (!invoice || invoice.deleted) throw new PaymentReviewError("The refunded Stripe invoice could not be retrieved.");
    const order = await findTradeInvoiceOrder(invoice);
    if (order?.payment_method === "net30") await applyTradeInvoiceEvent(stripe, order, invoice, false);
  }
}
