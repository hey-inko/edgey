import "server-only";
import type Stripe from "stripe";
import { createNet30OrderWithHolds } from "@/lib/credit";
import { stripeAccountId } from "./recovery";
import { recordTradeInvoiceState, releaseTerminalInvoice, retryCredit } from "./net30-ledger";
import {
  assertInvoiceAmounts, assertInvoiceIdentity, createTradeInvoice, finishTradeInvoice, readTradeInvoice, recoverTradeInvoice,
  rememberTradeInvoice, tradeCustomer, verifyStripeAccount, voidTradeInvoice,
} from "./net30-provider";
import { PaymentReviewError } from "./session-identity";
import { getOrder, paymentStore, type Order } from "./store";
import { getStripe } from "./stripe";

export async function net30Attempt(token: string, buyerId: string) {
  const { data, error } = await paymentStore().from("orders").select("*").eq("checkout_attempt_token", token)
    .eq("payment_method", "net30").eq("buyer_id", buyerId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function reserveNet30Order(input: Parameters<typeof createNet30OrderWithHolds>[0]) {
  const reserved = await retryCredit(() => createNet30OrderWithHolds(input));
  const order = await getOrder(reserved.id);
  if (!order || order.payment_method !== "net30") throw new PaymentReviewError("Could not read the reserved Net 30 order.");
  return order;
}

async function closeUnstarted(order: Order) {
  const { data } = await retryCredit(async () => {
    const result = await paymentStore().rpc("close_unstarted_net30_order", { p_order_id: order.id }).single();
    if (result.error) throw result.error;
    return result;
  });
  return data ?? order;
}

export async function reconcileNet30Order(stripe: Stripe, order: Order, close = false): Promise<Order> {
  if (order.fulfilment_status === "cancelled" && !order.provider_invoice_id) return order;
  let customer: string | undefined;
  if (!order.stripe_net30_started_at) {
    if (close || Date.now() >= Date.parse(order.hold_expires_at)) {
      order = await closeUnstarted(order);
      if (!order.stripe_net30_started_at) return order;
    } else {
      const accountId = await stripeAccountId(stripe);
      customer = await tradeCustomer(order, accountId);
      order = await retryCredit(async () => {
        const { data, error } = await paymentStore().rpc("start_net30_invoice", {
          p_order_id: order.id, p_account_id: accountId,
        }).single();
        if (error) throw error;
        return data;
      });
      if (!order.stripe_net30_started_at) return closeUnstarted(order);
    }
  }
  const accountId = await verifyStripeAccount(stripe, order);
  customer ??= await tradeCustomer(order, accountId);
  const customerId = customer;
  let invoice = await recoverTradeInvoice(stripe, order, customerId);
  if (invoice?.deleted || (!invoice && order.stripe_net30_invoice_id)) {
    return releaseTerminalInvoice(order, order.stripe_net30_invoice_id!, "deleted");
  }
  if (!invoice) {
    invoice = await createTradeInvoice(stripe, order, customerId).catch(async (error: unknown) => {
      const recovered = await recoverTradeInvoice(stripe, order, customerId);
      if (!recovered) throw error;
      return recovered;
    });
    if (invoice.deleted) throw new PaymentReviewError("Stripe returned a deleted invoice for an unlinked creation attempt.");
  }
  order = await rememberTradeInvoice(order, invoice);
  if (invoice.status === "draft" && (close || Date.now() >= Date.parse(order.hold_expires_at))) {
    try {
      const deleted = await stripe.invoices.del(invoice.id);
      if (deleted.id === invoice.id && deleted.deleted) return releaseTerminalInvoice(order, invoice.id, "deleted");
    } catch (error) {
      const current = await readTradeInvoice(stripe, invoice.id);
      if (!current || current.deleted) return releaseTerminalInvoice(order, invoice.id, "deleted");
      if (current.status === "draft") throw error;
      invoice = current;
    }
    if (invoice.status === "draft") throw new PaymentReviewError("Stripe did not confirm that the draft invoice closed.");
  }
  if (close && !order.stripe_net30_sent && invoice.status !== "void") {
    throw new PaymentReviewError("This Stripe invoice is still collectible. It cannot be closed from checkout.");
  }
  const issued = await finishTradeInvoice(stripe, order, invoice, customerId);
  order = await getOrder(order.id) ?? order;
  return recordTradeInvoiceState(stripe, order, customerId, issued);
}

export async function submitNet30Invoice(order: Order, close = false) {
  try {
    const next = close && !order.stripe_net30_started_at ? await closeUnstarted(order) : order;
    if (next.fulfilment_status === "cancelled" && !next.provider_invoice_id) return next;
    return await reconcileNet30Order(getStripe(), next, close);
  } catch {
    return await getOrder(order.id) ?? order;
  }
}

export async function voidCancelledNet30Invoice(orderId: string, actorId: string): Promise<void> {
  const db = paymentStore();
  const { data: role, error } = await db.from("staff_members").select("role")
    .eq("user_id", actorId).eq("role", "finance").maybeSingle();
  if (error) throw error;
  const order = role && await getOrder(orderId);
  if (!order || order.payment_method !== "net30" || order.fulfilment_status !== "cancelled" ||
    !order.provider_invoice_id || order.dispatched_at || order.paid_pence) {
    throw new PaymentReviewError("Only cancelled, undispatched Net 30 orders with no payment can be voided.");
  }
  const stripe = getStripe();
  const accountId = await verifyStripeAccount(stripe, order);
  const customer = await tradeCustomer(order, accountId);
  let invoice = await readTradeInvoice(stripe, order.provider_invoice_id);
  if (!invoice || invoice.deleted) throw new PaymentReviewError("The issued Stripe invoice could not be retrieved.");
  assertInvoiceIdentity(order, customer, invoice);
  assertInvoiceAmounts(order, invoice);
  if (invoice.status !== "void") {
    if (invoice.status !== "open" || invoice.amount_paid !== 0) {
      throw new PaymentReviewError("Stripe has not confirmed that this invoice is open and unpaid.");
    }
    try {
      invoice = await voidTradeInvoice(stripe, order, invoice.id);
    } catch (error) {
      const current = await readTradeInvoice(stripe, invoice.id);
      if (!current || current.deleted || current.status !== "void") throw error;
      invoice = current;
    }
  }
  if (invoice.status !== "void" || invoice.amount_paid !== 0) {
    throw new PaymentReviewError("Stripe did not confirm an unpaid, voided invoice.");
  }
  await recordTradeInvoiceState(stripe, order, customer, invoice);
}
