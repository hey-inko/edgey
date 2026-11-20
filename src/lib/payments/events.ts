import "server-only";
import type Stripe from "stripe";
import { markProviderEvent, recordProviderEvent, recordRefund } from "@/lib/orders";
import { findStripeSession } from "./recovery";
import { checkoutSessionId, orderId, PaymentReviewError, stripeId } from "./session-identity";
import { reconcileSession } from "./settle";
import { getOrder, paymentStore, type ProviderEvent } from "./store";

export const STRIPE_EVENT_TYPES = [
  "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed", "checkout.session.expired",
  "invoice.finalized", "charge.refunded", "refund.created", "refund.updated", "refund.failed",
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
  if (type === "invoice.finalized") {
    if (!/^in_[A-Za-z0-9]+$/.test(objectId)) throw new PaymentReviewError("Invalid Stripe Invoice ID.");
    const invoice = await stripe.invoices.retrieve(objectId);
    if (invoice.livemode || !invoice.metadata?.edgey_order_id) return;
    const order = await knownOrder(invoice.metadata.edgey_order_id);
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
    if (!intent.metadata.edgey_order_id) return;
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
  if (refund.status !== "succeeded" || intent.livemode || !intent.metadata.edgey_order_id) return;
  const order = await knownOrder(intent.metadata.edgey_order_id);
  if (stripeId(refund.payment_intent) !== intent.id) throw new PaymentReviewError("Stripe Refund does not match the order payment.");
  const session = await findStripeSession(stripe, order, intent.id);
  if (!session || stripeId(session.payment_intent) !== intent.id) {
    throw new PaymentReviewError("Could not match the refunded Stripe payment to its Checkout Session.");
  }
  const current = await reconcileSession(stripe, order, session);
  if (current.payment_review_refund_id === refund.id) return;
  if (!current.paid_pence) throw new PaymentReviewError("The refunded Stripe payment is awaiting capture reconciliation.");
  await recordRefund({
    orderId: order.id,
    refundId: refund.id,
    paymentIntentId: intent.id,
    amountPence: refund.amount,
    currency: refund.currency,
  });
}
