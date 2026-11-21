import "server-only";
import type Stripe from "stripe";
import { calculateDispatchPromise, STANDARD_DELIVERY_QUOTE } from "@/lib/commerce";
import { applyCreditNote, applyInvoicePayment, applyInvoiceRefund, releaseCreditHold, voidInvoice } from "@/lib/credit";
import { hostedStripeInvoice } from "@/lib/email/confirmation";
import { assertInvoiceAmounts, assertInvoiceIdentity, rememberTradeInvoice, tradeCustomer, verifyStripeAccount } from "./net30-provider";
import { orderId, PaymentReviewError, stripeId } from "./session-identity";
import { getOrder, paymentStore, type Order } from "./store";

type Evidence = { paymentId: string } | { creditNoteId: string };

export async function retryCredit<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt === 2 || !["40001", "40P01"].includes((error as { code?: string })?.code ?? "")) throw error;
    }
  }
}

export async function recordTradeInvoiceState(
  stripe: Stripe, order: Order, customer: string, invoice: Stripe.Invoice, evidence?: Evidence,
) {
  assertInvoiceIdentity(order, customer, invoice);
  if (invoice.status === "draft") return order;
  if (!order.provider_invoice_id && invoice.status === "void" && !invoice.amount_paid) {
    return releaseTerminalInvoice(order, invoice.id, "voided");
  }
  assertInvoiceAmounts(order, invoice);
  const issued = invoice.status_transitions.finalized_at;
  const due = invoice.due_date;
  if (!issued || !due || due <= issued || Math.abs(due - invoice.created - 30 * 86_400) > 86_400) {
    throw new PaymentReviewError("Stripe invoice dates do not agree with Net 30 terms.");
  }
  if (!order.provider_invoice_id) {
    if (!order.stripe_net30_sent) {
      throw new PaymentReviewError("Stripe has not confirmed that this Net 30 invoice was sent.");
    }
    if (!["open", "paid"].includes(invoice.status ?? "")) {
      throw new PaymentReviewError("The Net 30 invoice was not collectible when dispatch authorisation was checked.");
    }
    if (invoice.status === "paid" && invoice.amount_paid === 0) {
      throw new PaymentReviewError("Stripe credited the full balance before dispatch authorisation. Review the invoice and stock hold.");
    }
    const authorisedAt = new Date().toISOString();
    const promise = calculateDispatchPromise({ authorisedAt, deliveryQuote: STANDARD_DELIVERY_QUOTE });
    if (!promise.ok || !promise.value.estimatedDeliveryDate || order.delivery_service !== STANDARD_DELIVERY_QUOTE.serviceName) {
      throw new PaymentReviewError("Could not calculate the delivery promise for the Net 30 authorisation.");
    }
    order = await retryCredit(async () => {
      const { data, error } = await paymentStore().rpc("bind_issued_net30_invoice", {
        p_order_id: order.id, p_provider_invoice_id: invoice.id, p_stripe_customer_id: customer,
        p_amount_due_pence: order.gross_pence, p_currency: invoice.currency, p_authorised_at: authorisedAt,
        p_issued_at: new Date(issued * 1_000).toISOString(), p_due_at: new Date(due * 1_000).toISOString(),
        p_dispatch_date: promise.value.dispatchDate, p_delivery_date: promise.value.estimatedDeliveryDate!,
      }).single();
      if (error) throw error;
      return data;
    });
  }
  const url = hostedStripeInvoice(invoice.hosted_invoice_url);
  if (url && url !== order.buyer_invoice_url) {
    const { error } = await paymentStore().rpc("set_buyer_invoice_url", {
      p_order_id: order.id, p_provider_invoice_id: invoice.id, p_url: url,
    });
    if (error) throw error;
  }
  await settleTradeInvoice(stripe, order, invoice, evidence);
  return await getOrder(order.id) ?? order;
}

export async function releaseTerminalInvoice(order: Order, id: string, resolution: "deleted" | "voided"): Promise<Order> {
  if (order.fulfilment_status === "cancelled" && !order.provider_invoice_id) return order;
  if (order.provider_invoice_id) throw new PaymentReviewError("A bound invoice cannot release an unconverted credit hold.");
  try {
    return { ...order, ...await retryCredit(() => releaseCreditHold({
      orderId: order.id, operationKey: `net30-${resolution}:${id}`, resolution, providerInvoiceId: id,
    })) };
  } catch (error) {
    const current = await getOrder(order.id);
    if (resolution !== "voided" || current?.provider_invoice_id !== id) throw error;
    await retryCredit(() => voidInvoice(id));
    return await getOrder(order.id) ?? current;
  }
}

export async function applyTradeInvoiceEvent(
  stripe: Stripe, order: Order, invoice: Stripe.Invoice, sent: boolean, evidence?: Evidence,
) {
  if (!order.stripe_net30_started_at) {
    throw new PaymentReviewError("Stripe references a Net 30 order for which no provider request was started.");
  }
  const accountId = await verifyStripeAccount(stripe, order);
  const customer = await tradeCustomer(order, accountId);
  assertInvoiceIdentity(order, customer, invoice);
  order = await rememberTradeInvoice(order, invoice, sent);
  await recordTradeInvoiceState(stripe, order, customer, invoice, evidence);
}

export async function findTradeInvoiceOrder(invoice: Stripe.Invoice) {
  if (invoice.livemode !== false) return null;
  if (invoice.collection_method === "send_invoice") {
    const { data, error } = await paymentStore().from("orders").select("*")
      .eq("stripe_net30_invoice_id", invoice.id).maybeSingle();
    if (error) throw error;
    if (data) return data;
  }
  const reference = invoice.metadata?.edgey_order_id;
  if (!reference) return null;
  if (!orderId.test(reference)) throw new PaymentReviewError("Invalid Edgey order identity on Stripe invoice.");
  const order = await getOrder(reference);
  if (!order) throw new PaymentReviewError("Stripe references an Edgey order that does not exist.");
  return order;
}

async function settleTradeInvoice(stripe: Stripe, order: Order, invoice: Stripe.Invoice, evidence?: Evidence) {
  const payments = invoice.amount_paid > 0 || order.paid_pence > 0
    ? await stripe.invoicePayments.list({ invoice: invoice.id, status: "paid", limit: 100 }) : null;
  const notes = invoice.pre_payment_credit_notes_amount || invoice.post_payment_credit_notes_amount ||
    invoice.amount_due !== order.gross_pence || order.payment_status !== "invoiced"
    ? await stripe.creditNotes.list({ invoice: invoice.id, limit: 100 }) : null;
  if (payments?.has_more || notes?.has_more) throw new PaymentReviewError("This invoice has too many payment or credit operations to reconcile automatically.");
  const allocations = payments?.data ?? [];
  const credits = notes?.data ?? [];
  if ((evidence && "paymentId" in evidence && !allocations.some((payment) => payment.id === evidence.paymentId)) ||
    (evidence && "creditNoteId" in evidence && !credits.some((note) => note.id === evidence.creditNoteId))) {
    throw new PaymentReviewError("The referenced Stripe payment or credit note is not yet reflected in the invoice.");
  }
  if (allocations.some((payment) => !/^inpay_[A-Za-z0-9]{1,194}$/.test(payment.id) ||
    stripeId(payment.invoice) !== invoice.id || payment.status !== "paid" ||
    payment.livemode !== false || payment.currency !== invoice.currency || !payment.amount_paid ||
    !Number.isSafeInteger(payment.amount_paid) || payment.amount_paid < 0) ||
    allocations.reduce((total, payment) => total + payment.amount_paid!, 0) !== invoice.amount_paid) {
    throw new PaymentReviewError("Stripe invoice payment allocations do not agree with its paid amount.");
  }
  if (credits.some((note) => !/^cn_[A-Za-z0-9]{1,197}$/.test(note.id) ||
    stripeId(note.invoice) !== invoice.id || note.status !== "issued" ||
    note.livemode !== false || note.currency !== invoice.currency || note.total <= 0 ||
    note.pre_payment_amount < 0 || note.post_payment_amount < 0 ||
    note.total !== note.pre_payment_amount + note.post_payment_amount) ||
    credits.reduce((total, note) => total + note.pre_payment_amount, 0) !== invoice.pre_payment_credit_notes_amount ||
    credits.reduce((total, note) => total + note.post_payment_amount, 0) !== invoice.post_payment_credit_notes_amount) {
    throw new PaymentReviewError("Stripe credit notes do not agree with this invoice. Review voided or changed credit notes.");
  }
  const base = { providerInvoiceId: invoice.id, currency: invoice.currency };
  for (const payment of allocations) {
    await retryCredit(() => applyInvoicePayment({ ...base, operationKey: payment.id, amountPence: payment.amount_paid! }));
  }
  for (const note of credits) {
    await retryCredit(() => applyCreditNote({
      ...base, operationKey: note.id, amountPence: note.total, prePaymentPence: note.pre_payment_amount,
    }));
  }
  for (const payment of allocations) await reconcileTradeRefunds(stripe, invoice, payment);
  if (invoice.status === "void") await retryCredit(() => voidInvoice(invoice.id));
  const { data, error } = await paymentStore().from("invoices").select("amount_remaining_pence,status")
    .eq("order_id", order.id).single();
  if (error) throw error;
  if (data.amount_remaining_pence !== (invoice.status === "void" ? 0 : invoice.amount_remaining) ||
    (invoice.status === "paid" && !["paid", "credited"].includes(data.status)) ||
    (invoice.status === "open" && !["open", "partially_paid"].includes(data.status))) {
    throw new PaymentReviewError("The Stripe invoice balance does not match the trade credit ledger.");
  }
  if (invoice.status === "uncollectible") {
    throw new PaymentReviewError("Stripe marked the invoice uncollectible. Outstanding credit remains until finance reconciles it.");
  }
}

async function reconcileTradeRefunds(stripe: Stripe, invoice: Stripe.Invoice, payment: Stripe.InvoicePayment) {
  const intent = stripeId(payment.payment.payment_intent);
  const charge = stripeId(payment.payment.charge);
  if (!intent && !charge) return;
  const refunds = await stripe.refunds.list(intent ? { payment_intent: intent, limit: 100 } : { charge, limit: 100 });
  if (refunds.has_more) throw new PaymentReviewError("This invoice has too many refunds to reconcile automatically.");
  const succeeded = refunds.data.filter((refund) => refund.status === "succeeded");
  if (!succeeded.length) return;
  if (intent) {
    const [capture, uses] = await Promise.all([
      stripe.paymentIntents.retrieve(intent),
      stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: intent }, status: "paid", limit: 2 }),
    ]);
    if (capture.id !== intent || capture.livemode !== false || capture.status !== "succeeded" ||
      capture.currency !== invoice.currency || capture.amount_received !== payment.amount_paid ||
      uses.has_more || uses.data.length !== 1 || uses.data[0]?.id !== payment.id) {
      throw new PaymentReviewError("Finance must allocate the refund for a payment shared with another invoice or use.");
    }
  }
  if (succeeded.some((refund) => !/^re_[A-Za-z0-9]{1,197}$/.test(refund.id) ||
    !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || refund.currency !== invoice.currency ||
    (intent ? stripeId(refund.payment_intent) !== intent : stripeId(refund.charge) !== charge)) ||
    succeeded.reduce((sum, refund) => sum + refund.amount, 0) > payment.amount_paid!) {
    throw new PaymentReviewError("Stripe refunds exceed or do not match their invoice payment.");
  }
  for (const refund of succeeded) {
    await retryCredit(() => applyInvoiceRefund({
      providerInvoiceId: invoice.id, operationKey: refund.id, amountPence: refund.amount, currency: refund.currency,
    }));
  }
}
