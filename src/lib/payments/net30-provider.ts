import "server-only";
import type Stripe from "stripe";
import { calculateVat } from "@/lib/commerce";
import { PaymentReviewError, stripeId } from "./session-identity";
import { getOrder, getOrderItems, paymentStore, type Order } from "./store";
import { stripeAccountId } from "./recovery";

const invoiceId = /^in_[A-Za-z0-9]{1,197}$/;
const providerWriteWindow = 23 * 60 * 60_000;
const key = (order: Order, stage: string) => ({ idempotencyKey: `edgey:net30:v1:${order.id}:${stage}` });

export async function tradeCustomer(order: Order, accountId: string) {
  if (order.payment_method !== "net30" || !order.trade_account_id) {
    throw new PaymentReviewError("The order is not linked to a trade account.");
  }
  const { data, error } = await paymentStore().from("trade_accounts")
    .select("stripe_customer_id,trade_applications(approval_stripe_account_id,billing_line1,billing_town,billing_postcode)")
    .eq("id", order.trade_account_id).single();
  if (error) throw error;
  const application = data.trade_applications;
  if (!data.stripe_customer_id || !application?.billing_line1 || !application.billing_town || !application.billing_postcode) {
    throw new PaymentReviewError("The trade account is missing its Stripe customer or approved billing details.");
  }
  if (application.approval_stripe_account_id && application.approval_stripe_account_id !== accountId) {
    throw new PaymentReviewError("The trade customer was provisioned in a different Stripe sandbox.");
  }
  return data.stripe_customer_id;
}

export function assertInvoiceIdentity(order: Order, customer: string, invoice: Stripe.Invoice) {
  if (!invoiceId.test(invoice.id) || invoice.livemode !== false || invoice.collection_method !== "send_invoice" ||
    stripeId(invoice.customer) !== customer || invoice.metadata?.edgey_order_id !== order.id ||
    invoice.metadata.edgey_payment_method !== "net30" || invoice.metadata.po_number !== order.po_number ||
    invoice.currency.toUpperCase() !== order.currency || invoice.from_invoice || invoice.latest_revision ||
    (order.stripe_net30_invoice_id && invoice.id !== order.stripe_net30_invoice_id) ||
    (order.provider_invoice_id && invoice.id !== order.provider_invoice_id)) {
    throw new PaymentReviewError("Stripe invoice identity does not match the Net 30 order.");
  }
}

export async function verifyStripeAccount(stripe: Stripe, order: Order) {
  const account = await stripeAccountId(stripe);
  if (order.stripe_net30_account_id !== account) {
    throw new PaymentReviewError("The configured Stripe sandbox differs from the one used for this invoice.");
  }
  return account;
}

export async function readTradeInvoice(stripe: Stripe, id: string) {
  if (!invoiceId.test(id)) throw new PaymentReviewError("Invalid Stripe invoice ID.");
  try {
    const invoice = await stripe.invoices.retrieve(id);
    if (invoice.id !== id) throw new PaymentReviewError("Stripe returned a different invoice.");
    return invoice;
  } catch (error) {
    if ((error as { code?: string })?.code === "resource_missing") return null;
    throw error;
  }
}

export async function recoverTradeInvoice(stripe: Stripe, order: Order, customer: string) {
  const id = order.stripe_net30_invoice_id ?? order.provider_invoice_id;
  if (id) {
    const invoice = await readTradeInvoice(stripe, id);
    if (invoice && !invoice.deleted) assertInvoiceIdentity(order, customer, invoice);
    return invoice;
  }
  let match: Stripe.Invoice | undefined;
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const invoices = await stripe.invoices.list({
      customer, limit: 100, starting_after: cursor,
      created: { gte: Math.floor(Date.parse(order.stripe_net30_started_at!) / 1_000) - 60 },
    });
    for (const invoice of invoices.data) {
      if (invoice.metadata?.edgey_order_id !== order.id) continue;
      assertInvoiceIdentity(order, customer, invoice);
      if (match) throw new PaymentReviewError("Multiple Stripe invoices reference this Net 30 order.");
      match = invoice;
    }
    if (!invoices.has_more) return match ?? null;
    cursor = invoices.data.at(-1)?.id;
    if (!cursor) break;
  }
  throw new PaymentReviewError("Stripe invoice recovery could not cover the whole order window.");
}

export async function rememberTradeInvoice(order: Order, invoice: Stripe.Invoice, sent = false) {
  if ((order.stripe_net30_invoice_id ?? invoice.id) !== invoice.id) {
    throw new PaymentReviewError("A different Stripe invoice is already recorded for this order.");
  }
  if (order.stripe_net30_invoice_id !== invoice.id || (sent && !order.stripe_net30_sent)) {
    const { error } = await paymentStore().from("orders")
      .update({ stripe_net30_invoice_id: invoice.id, ...(sent ? { stripe_net30_sent: true } : {}) })
      .eq("id", order.id).eq("stripe_net30_account_id", order.stripe_net30_account_id!)
      .or(`stripe_net30_invoice_id.is.null,stripe_net30_invoice_id.eq.${invoice.id}`);
    if (error) throw error;
    const current = await getOrder(order.id);
    if (!current || current.stripe_net30_invoice_id !== invoice.id || (sent && !current.stripe_net30_sent)) {
      throw new PaymentReviewError("Could not record Stripe invoice evidence.");
    }
    return current;
  }
  return order;
}

function withinWriteWindow(order: Order) {
  return Date.now() - Date.parse(order.stripe_net30_started_at!) < providerWriteWindow;
}

export async function createTradeInvoice(stripe: Stripe, order: Order, customer: string) {
  if (order.stripe_net30_invoice_id || !withinWriteWindow(order)) {
    throw new PaymentReviewError("An earlier Stripe invoice request could not be verified. Review it before releasing the holds.");
  }
  const invoice = await stripe.invoices.create({
    customer,
    collection_method: "send_invoice",
    days_until_due: 30,
    currency: "gbp",
    auto_advance: false,
    automatic_tax: { enabled: false },
    pending_invoice_items_behavior: "exclude",
    discounts: "",
    metadata: { edgey_order_id: order.id, edgey_payment_method: "net30", po_number: order.po_number! },
    description: `Edgey order ${order.order_reference}\nPurchase order: ${order.po_number}`,
    shipping_details: {
      name: order.recipient_name,
      address: {
        line1: order.address_line1, line2: order.address_line2 ?? undefined, city: order.address_town,
        state: order.address_region ?? undefined, postal_code: order.address_postcode, country: "GB",
      },
    },
  }, key(order, "create"));
  assertInvoiceIdentity(order, customer, invoice);
  return invoice;
}

async function invoiceLines(order: Order): Promise<Stripe.InvoiceAddLinesParams["lines"]> {
  const items = await getOrderItems(order.id);
  const deliveryTax = calculateVat(order.delivery_net_pence, order.vat_rate_bps);
  if (!deliveryTax.ok || !items.length || items.length + Number(order.delivery_net_pence > 0) > 100 ||
    items.reduce((sum, item) => sum + item.net_pence, 0) !== order.goods_net_pence ||
    items.reduce((sum, item) => sum + item.tax_pence, deliveryTax.value) !== order.vat_pence ||
    order.goods_net_pence + order.delivery_net_pence + order.vat_pence !== order.gross_pence) {
    throw new PaymentReviewError("Could not reproduce the saved amounts for this Net 30 order.");
  }
  const line = (description: string, net: number, tax: number): Stripe.InvoiceAddLinesParams.Line => ({
    description,
    amount: net,
    discountable: false,
    tax_amounts: [{ amount: tax, taxable_amount: net, tax_rate_data: {
      display_name: "VAT", country: "GB", inclusive: false, percentage: order.vat_rate_bps / 100, tax_type: "vat",
    } }],
  });
  return [
    ...items.map((item) => line(`${item.quantity} × ${item.sku} · ${item.option_label}`.slice(0, 250), item.net_pence, item.tax_pence)),
    ...(order.delivery_net_pence ? [line(`Delivery · ${order.delivery_service}`, order.delivery_net_pence, deliveryTax.value)] : []),
  ];
}

export function assertInvoiceAmounts(order: Order, invoice: Stripe.Invoice) {
  const preCredit = invoice.pre_payment_credit_notes_amount;
  if (invoice.metadata?.edgey_lines_version !== "1" ||
    invoice.total !== order.gross_pence || invoice.total_excluding_tax !== order.goods_net_pence + order.delivery_net_pence ||
    invoice.total_taxes?.reduce((sum, tax) => sum + tax.amount, 0) !== order.vat_pence ||
    invoice.starting_balance !== 0 || invoice.amount_overpaid !== 0 ||
    !Number.isInteger(preCredit) || preCredit < 0 || preCredit > order.gross_pence ||
    (invoice.status !== "void" && invoice.amount_due + preCredit !== order.gross_pence)) {
    throw new PaymentReviewError("The Stripe invoice does not agree with the order’s saved GBP and VAT totals.");
  }
}

export async function finishTradeInvoice(stripe: Stripe, order: Order, invoice: Stripe.Invoice, customer: string) {
  if (invoice.status === "draft") {
    if (invoice.metadata?.edgey_lines_version !== "1") {
      if (!withinWriteWindow(order) || invoice.lines?.data.length) {
        throw new PaymentReviewError("Existing draft lines need review before the invoice can be finalised.");
      }
      invoice = await stripe.invoices.addLines(invoice.id, {
        lines: await invoiceLines(order), invoice_metadata: { edgey_lines_version: "1" },
      }, key(order, "lines"));
    }
    assertInvoiceIdentity(order, customer, invoice);
    assertInvoiceAmounts(order, invoice);
    invoice = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false }, key(order, "finalise"));
    assertInvoiceIdentity(order, customer, invoice);
  }
  if (!order.stripe_net30_sent && (invoice.status === "open" || invoice.status === "paid")) {
    assertInvoiceAmounts(order, invoice);
    if (!withinWriteWindow(order)) {
      throw new PaymentReviewError("Stripe invoice send could not be confirmed within its retry window.");
    }
    const sent = await stripe.invoices.sendInvoice(invoice.id, {}, key(order, "send"));
    assertInvoiceIdentity(order, customer, sent);
    await rememberTradeInvoice(order, sent, true);
    return sent;
  }
  return invoice;
}

export function voidTradeInvoice(stripe: Stripe, order: Order, id: string) {
  return stripe.invoices.voidInvoice(id, {}, key(order, "void"));
}
