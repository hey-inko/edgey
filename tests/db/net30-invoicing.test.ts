import { randomUUID } from "node:crypto";
import { Client } from "pg";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { POST as net30 } from "@/app/api/checkout/net30/route";
import { POST as webhook } from "@/app/api/webhooks/stripe/route";
import { getBuyerSession, getVerifiedBuyer } from "@/lib/auth/server";
import { quoteCurrentSelection } from "@/lib/checkout/server";
import { voidCancelledNet30Invoice } from "@/lib/payments/net30";
import { reconcileStripePayments } from "@/lib/payments/reconciliation";
import { requestFingerprint } from "@/lib/requests/rate-limit";
import { withExhaustedQuoteBudget } from "../helpers/quote-budget";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/server", () => ({ getBuyerSession: vi.fn(), getVerifiedBuyer: vi.fn() }));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => stripe }));

const providerId = (prefix: string) => prefix + "_" + randomUUID().replaceAll("-", "");
const signer = new Stripe("sk_test_fixture");
const webhookSecret = "whsec_net30_fixture";
const origin = "http://127.0.0.1:3000";
const invoices = new Map<string, Stripe.Invoice>();
const byKey = new Map<string, Stripe.Invoice>();
const payments = new Map<string, Stripe.InvoicePayment>();
const credits = new Map<string, Stripe.CreditNote>();
const refunds = new Map<string, Stripe.Refund>();
const captures = new Map<string, Stripe.PaymentIntent>();
const eventIds: string[] = [];
const userIds: string[] = [];
const tradeAccounts: string[] = [];
const applications: string[] = [];
const variantIds: string[] = [];
const tokens: string[] = [];
let db: Client;

function lineTax(line: Stripe.InvoiceAddLinesParams.Line) {
  return Array.isArray(line.tax_amounts) ? line.tax_amounts[0]!.amount : 0;
}

const read = (id: string) => {
  const invoice = invoices.get(id);
  if (!invoice) throw Object.assign(new Error("No mock invoice"), { code: "resource_missing" });
  return invoice;
};
const stripe = {
  accounts: { retrieveCurrent: vi.fn(async () => ({ id: "acct_net30Fixture" })) },
  invoices: {
    create: vi.fn(async (params: Stripe.InvoiceCreateParams, options: Stripe.RequestOptions) => {
      const key = options.idempotencyKey!;
      const existing = byKey.get(key);
      if (existing) return existing;
      const id = providerId("in");
      const now = Math.floor(Date.now() / 1000);
      const invoice = {
        id, customer: params.customer, metadata: { ...params.metadata }, livemode: false, collection_method: params.collection_method,
        currency: params.currency, status: "draft", created: now, due_date: now + params.days_until_due! * 86_400,
        total: 0, total_excluding_tax: 0, total_taxes: [], amount_due: 0, amount_remaining: 0, amount_paid: 0,
        starting_balance: 0, amount_overpaid: 0, status_transitions: { finalized_at: null }, lines: { data: [] },
        pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
      } as unknown as Stripe.Invoice;
      invoices.set(id, invoice);
      byKey.set(key, invoice);
      return invoice;
    }),
    retrieve: vi.fn(async (id: string) => read(id)),
    list: vi.fn(async ({ customer }: Stripe.InvoiceListParams) => ({
      data: [...invoices.values()].filter((invoice) => invoice.customer === customer), has_more: false,
    })),
    addLines: vi.fn(async (id: string, params: Stripe.InvoiceAddLinesParams) => {
      const invoice = read(id);
      invoice.metadata = { ...invoice.metadata, ...params.invoice_metadata };
      invoice.total_excluding_tax = params.lines.reduce((sum, line) => sum + line.amount!, 0);
      const tax = params.lines.reduce((sum, line) => sum + lineTax(line), 0);
      invoice.total_taxes = [{ amount: tax }] as Stripe.Invoice.TotalTax[];
      invoice.amount_due = invoice.amount_remaining = invoice.total = invoice.total_excluding_tax + tax;
      return invoice;
    }),
    finalizeInvoice: vi.fn(async (id: string) => {
      const invoice = read(id);
      invoice.status = "open";
      invoice.status_transitions.finalized_at = invoice.created;
      invoice.hosted_invoice_url = `https://invoice.stripe.com/i/${id}`;
      return invoice;
    }),
    sendInvoice: vi.fn(async (id: string) => read(id)),
    voidInvoice: vi.fn(async (id: string) => {
      const invoice = read(id);
      invoice.status = "void";
      invoice.amount_remaining = 0;
      return invoice;
    }),
    del: vi.fn(async (id: string) => {
      if (read(id).status !== "draft") throw new Error("Only drafts can be deleted");
      invoices.delete(id);
      return { id, deleted: true };
    }),
  },
  invoicePayments: {
    retrieve: vi.fn(async (id: string) => payments.get(id)),
    list: vi.fn(async (filter: Stripe.InvoicePaymentListParams) => ({
      data: [...payments.values()].filter((payment) => (!filter.invoice || filter.invoice === payment.invoice) &&
        (!filter.payment || filter.payment.payment_intent === payment.payment.payment_intent)),
      has_more: false,
    })),
  },
  creditNotes: {
    retrieve: vi.fn(async (id: string) => credits.get(id)),
    list: vi.fn(async ({ invoice }: Stripe.CreditNoteListParams) => ({
      data: [...credits.values()].filter((note) => note.invoice === invoice), has_more: false,
    })),
  },
  refunds: {
    retrieve: vi.fn(async (id: string) => refunds.get(id)),
    list: vi.fn(async ({ payment_intent }: Stripe.RefundListParams) => ({
      data: [...refunds.values()].filter((refund) => refund.payment_intent === payment_intent), has_more: false,
    })),
  },
  paymentIntents: { retrieve: vi.fn(async (id: string) => captures.get(id)) },
  webhooks: signer.webhooks,
};

beforeAll(async () => {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString || ![connectionString, process.env.NEXT_PUBLIC_SUPABASE_URL].every((url) =>
    url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname))) {
    throw new Error("These tests require local Supabase.");
  }
  db = new Client({ connectionString, statement_timeout: 8_000 });
  await db.connect();
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("NET30_CHECKOUT_ENABLED", "true");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", webhookSecret);
  vi.stubEnv("EDGEY_REQUEST_HASH_KEY", randomUUID() + randomUUID());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const store of [invoices, byKey, payments, credits, refunds, captures]) store.clear();
  const orderIds = (await db.query<{ id: string }>(
    "select id from public.orders where checkout_attempt_token = any($1)", [tokens],
  )).rows.map((row) => row.id);
  for (const table of ["public.credit_ledger", "public.credit_holds", "public.invoices", "private.order_operations",
    "public.order_outbox", "public.stock_movements", "public.stock_reservations", "public.order_items"]) {
    await db.query(`delete from ${table} where order_id = any($1)`, [orderIds]);
  }
  await db.query("delete from public.orders where id = any($1)", [orderIds]);
  await db.query("delete from private.closed_checkout_attempts where attempt_token = any($1)", [tokens.splice(0)]);
  await db.query("delete from public.credit_ledger where trade_account_id = any($1)", [tradeAccounts]);
  await db.query("delete from public.trade_accounts where id = any($1)", [tradeAccounts.splice(0)]);
  await db.query("delete from public.order_outbox where trade_application_id = any($1)", [applications]);
  await db.query("delete from public.trade_applications where id = any($1)", [applications.splice(0)]);
  await db.query("delete from auth.users where id = any($1)", [userIds.splice(0)]);
  await db.query("delete from public.variants where id = any($1)", [variantIds.splice(0)]);
  await db.query("delete from public.provider_events where provider = 'stripe' and event_id = any($1)", [eventIds.splice(0)]);
});
afterAll(() => db?.end());

async function user(role?: "warehouse" | "finance") {
  const id = randomUUID(), email = `${id}@example.test`;
  userIds.push(id);
  await db.query("insert into auth.users (id, email, email_confirmed_at, is_anonymous) values ($1, $2, now(), false)", [id, email]);
  if (role) await db.query("insert into public.staff_members (user_id,role) values ($1,$2)", [id, role]);
  return { id, email };
}

function signIn(buyer: Awaited<ReturnType<typeof user>> | null) {
  vi.mocked(getVerifiedBuyer).mockResolvedValue(buyer);
  vi.mocked(getBuyerSession).mockResolvedValue(buyer ? { status: "verified", buyer } : { status: "guest" });
}

async function openAccount(limit = 20_000) {
  const [buyer, staff] = await Promise.all([user(), user("finance")]);
  const application = randomUUID();
  applications.push(application);
  await db.query("select public.submit_trade_application($1,$2,'Buyer','Fixture Ltd','1 Invoice Road','London','SW1A 1AA')", [application, buyer.id]);
  await db.query("select public.review_trade_application($1,$2,'approved')", [application, staff.id]);
  const customer = providerId("cus");
  const { rows: [account] } = await db.query<{ id: string }>(
    "select id from public.approve_trade_account($1,$2,$3,$4)", [application, staff.id, limit, customer],
  );
  if (!account) throw new Error("Could not create a fixture trade account.");
  tradeAccounts.push(account.id);
  signIn(buyer);
  return { buyer, staff, customer, accountId: account.id };
}

async function variant(stock = 5) {
  const id = randomUUID();
  variantIds.push(id);
  await db.query(`
    insert into public.variants (id, product_id, sku, supplier_part_number, price_1_4_pence,
      price_5_9_pence, price_10_plus_pence, stock_on_hand, publication_status, approved_at, evidence_source)
    select $1, id, $2, 'NET30-FIXTURE', 9305, 9305, 9305, $3, 'published', now(), 'Net 30 test'
    from public.products where family_code = 'EDG-Z10'
  `, [id, "NET30-" + id, stock]);
  return id;
}

async function input(variantId: string, email: string, poReference = "PO-120") {
  const token = randomUUID();
  tokens.push(token);
  const lines = [{ variantId, quantity: 1 }];
  const quote = await quoteCurrentSelection(lines, "SW1A 1AA");
  if (quote.status !== "ok") throw new Error(quote.message);
  expect(quote.basket?.totalGrossPence).toBe(12_000);
  return { lines, attemptToken: token, poReference, quoteKey: quote.quoteKey, fields: {
    businessName: "Fixture Ltd", recipientName: "Test Buyer", buyingForWork: true, email,
    postcode: "SW1A 1AA", line1: "5 Dispatch Road", town: "London",
  } };
}

function submit(body: unknown) {
  return net30(new Request(origin + "/api/checkout/net30", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
  }));
}

async function placeOrder(buyer: Awaited<ReturnType<typeof user>>, variantId = "") {
  const response = await submit(await input(variantId || await variant(), buyer.email));
  const result = await response.json();
  expect(result).toMatchObject({ status: "authorised" });
  expect(response.status).toBe(200);
  const invoice = [...invoices.values()].find((item) => item.metadata?.edgey_order_id === result.orderId)!;
  return { orderId: result.orderId as string, invoice };
}

async function event(type: string, objectId: string, eventId = providerId("evt")) {
  eventIds.push(eventId);
  const payload = JSON.stringify({ id: eventId, object: "event", livemode: false, type, data: { object: { id: objectId } } });
  const signature = signer.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
  const response = await webhook(new Request(origin + "/api/webhooks/stripe", {
    method: "POST", body: payload, headers: { "Stripe-Signature": signature },
  }));
  expect(response.status).toBe(200);
  const { rows: [stored] } = await db.query("select state, last_error from public.provider_events where event_id = $1", [eventId]);
  return { eventId, stored };
}

async function position(accountId: string) {
  const { rows: [row] } = await db.query(`
    select held_pence::int,outstanding_pence::int,available_credit_pence::int
    from public.trade_credit_position where trade_account_id=$1
  `, [accountId]);
  return row;
}

function allocate(invoice: Stripe.Invoice, amount: number, intent?: string) {
  const id = providerId("inpay");
  payments.set(id, {
    id, invoice: invoice.id, status: "paid", amount_paid: amount, currency: "gbp", livemode: false,
    payment: intent ? { type: "payment_intent", payment_intent: intent } : { type: "payment_record" },
  } as Stripe.InvoicePayment);
  invoice.amount_paid += amount;
  invoice.amount_remaining -= amount;
  if (!invoice.amount_remaining) invoice.status = "paid";
  return id;
}

it("serializes two £120 checkouts against £200 of credit and issues one invoice", async () => {
  const { buyer, accountId, customer } = await openAccount();
  const variantId = await variant();
  const [a, b] = await Promise.all([input(variantId, buyer.email, "PO-FIRST"), input(variantId, buyer.email, "PO-SECOND")]);
  const results = await Promise.all([submit(a), submit(b)]).then((responses) => Promise.all(responses.map((r) => r.json())));
  expect(results).toEqual(expect.arrayContaining([
    { status: "authorised", orderId: expect.any(String) }, { status: "trade-unavailable", reason: "over-limit" },
  ]));
  expect(stripe.invoices.create).toHaveBeenCalledOnce();
  expect(stripe.invoices.create).toHaveBeenCalledWith(expect.objectContaining({
    customer, collection_method: "send_invoice", days_until_due: 30, auto_advance: false,
    metadata: expect.objectContaining({ po_number: expect.stringMatching(/^PO-(FIRST|SECOND)$/) }),
  }), expect.objectContaining({ idempotencyKey: expect.stringMatching(/^edgey:net30:v1:.*:create$/) }));
  expect(stripe.invoices.addLines.mock.calls[0]?.[1].lines.map((line) => [line.amount, lineTax(line)]))
    .toEqual([[9305, 1861], [695, 139]]);
  expect(await position(accountId)).toEqual({ held_pence: 0, outstanding_pence: 12000, available_credit_pence: 8000 });
});

it("does not apply the public quote quota to a current Net 30 checkout", async () => {
  const { buyer } = await openAccount();
  const current = await input(await variant(), buyer.email);
  await withExhaustedQuoteBudget(db, requestFingerprint("ip", "local"), async () => {
    const response = await submit(current);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "authorised" });
  });
});

it("recovers a committed but timed-out invoice before repricing and never sends twice", async () => {
  const { buyer, accountId } = await openAccount();
  const attempt = await input(await variant(1), buyer.email);
  const create = stripe.invoices.create.getMockImplementation()!;
  stripe.invoices.create.mockImplementationOnce(async (...args) => {
    await create(...args);
    stripe.invoices.list.mockRejectedValueOnce(new Error("Stripe disconnected"));
    throw new Error("Stripe disconnected");
  });
  const first = await submit(attempt);
  expect(first.status).toBe(202);
  const { orderId } = await first.json();
  expect(await position(accountId)).toEqual({ held_pence: 12000, outstanding_pence: 0, available_credit_pence: 8000 });
  const second = await submit(attempt);
  expect(await second.json()).toEqual({ status: "authorised", orderId });
  expect(await (await submit({ action: "resume", attemptToken: attempt.attemptToken })).json()).toEqual({ status: "authorised", orderId });
  expect(stripe.invoices.create).toHaveBeenCalledOnce();
  expect(stripe.invoices.sendInvoice).toHaveBeenCalledOnce();
  expect(invoices.size).toBe(1);
  expect((await db.query("select po_number from public.orders where trade_account_id=$1", [accountId])).rows)
    .toEqual([{ po_number: "PO-120" }]);
  expect(await position(accountId)).toEqual({ held_pence: 0, outstanding_pence: 12000, available_credit_pence: 8000 });
});

it("uses a signed send event to authorise after a lost send response", async () => {
  const { buyer, accountId } = await openAccount();
  const attempt = await input(await variant(), buyer.email);
  stripe.invoices.sendInvoice.mockRejectedValueOnce(new Error("Send response lost"));
  const result = await (await submit(attempt)).json();
  expect(result).toEqual({ status: "confirming", orderId: expect.any(String) });
  const [invoice] = invoices.values();
  expect(await position(accountId)).toMatchObject({ held_pence: 12_000, outstanding_pence: 0 });
  expect((await event("invoice.finalized", invoice!.id)).stored.state).toBe("failed");
  expect((await event("invoice.sent", invoice!.id)).stored.state).toBe("processed");
  expect(await (await submit({ action: "resume", attemptToken: attempt.attemptToken })).json())
    .toEqual({ status: "authorised", orderId: result.orderId });
  expect(stripe.invoices.sendInvoice).toHaveBeenCalledOnce();
  expect(await position(accountId)).toMatchObject({ held_pence: 0, outstanding_pence: 12_000 });
});

it("releases an expired attempt only after closing its verified Stripe draft", async () => {
  const { buyer, accountId } = await openAccount();
  const variantId = await variant(1);
  const attempt = await input(variantId, buyer.email);
  stripe.invoices.addLines.mockRejectedValueOnce(new Error("Connection lost"));
  const result = await (await submit(attempt)).json();
  expect(result).toEqual({ status: "confirming", orderId: expect.any(String) });
  await db.query("update public.orders set created_at=now()-interval '36 minutes', hold_expires_at=now()-interval '1 minute' where id=$1", [result.orderId]);
  stripe.invoices.del.mockRejectedValueOnce(new Error("Deletion not confirmed"));
  await reconcileStripePayments();
  expect(await position(accountId)).toMatchObject({ held_pence: 12_000, outstanding_pence: 0 });
  const completed = await submit({ action: "resume", attemptToken: attempt.attemptToken });
  expect(await completed.json()).toMatchObject({ attemptClosed: true });
  expect(stripe.invoices.del).toHaveBeenCalledTimes(2);
  expect(stripe.invoices.sendInvoice).not.toHaveBeenCalled();
  expect(await position(accountId)).toMatchObject({ held_pence: 0, outstanding_pence: 0, available_credit_pence: 20_000 });
  expect((await db.query("select stock_reserved from public.variants where id=$1", [variantId])).rows)
    .toEqual([{ stock_reserved: 0 }]);
});

it("keeps an unknown creation held until writes are fenced and Stripe confirms a complete empty listing", async () => {
  const { buyer, accountId } = await openAccount();
  const attempt = await input(await variant(1), buyer.email);
  stripe.invoices.create.mockRejectedValueOnce(new Error("Transport disconnected before any invoice was returned"));
  const { orderId, status } = await (await submit(attempt)).json();
  expect(status).toBe("confirming");
  await db.query(`update public.orders set created_at=now()-interval '24 hours',
    stripe_net30_started_at=now()-interval '23 hours 1 minute', hold_expires_at=now()-interval '1 minute' where id=$1`, [orderId]);
  const resume = () => submit({ action: "resume", attemptToken: attempt.attemptToken });
  expect(await (await resume()).json()).toEqual({ status: "confirming", orderId });
  expect(await position(accountId)).toMatchObject({ held_pence: 12_000 });
  await db.query("update public.orders set stripe_net30_started_at=now()-interval '24 hours 1 minute' where id=$1", [orderId]);
  stripe.invoices.list.mockResolvedValueOnce({ data: [], has_more: true });
  expect(await (await resume()).json()).toEqual({ status: "confirming", orderId });
  expect(await position(accountId)).toMatchObject({ held_pence: 12_000 });
  expect(await (await resume()).json()).toMatchObject({ attemptClosed: true });
  expect(await position(accountId)).toMatchObject({ held_pence: 0, available_credit_pence: 20_000 });
  expect(stripe.invoices.create).toHaveBeenCalledOnce();
});

it("does not reserve for guests, unapproved, suspended or over-limit buyers and tombstones a closed missing attempt", async () => {
  const { buyer, accountId } = await openAccount(11_999);
  const variantId = await variant();
  const attempt = await input(variantId, buyer.email);
  signIn(null);
  expect(await (await submit(attempt)).json()).toEqual({ status: "trade-unavailable", reason: "not-approved" });
  signIn(await user());
  expect(await (await submit(await input(variantId, buyer.email))).json()).toEqual({ status: "trade-unavailable", reason: "not-approved" });
  signIn(buyer);
  expect(await (await submit(attempt)).json()).toEqual({ status: "trade-unavailable", reason: "over-limit" });
  await db.query("update public.trade_accounts set status='suspended' where id=$1", [accountId]);
  expect(await (await submit(await input(variantId, buyer.email))).json()).toEqual({ status: "trade-unavailable", reason: "suspended" });
  expect(await (await submit({ action: "close", attemptToken: attempt.attemptToken })).json()).toMatchObject({ attemptClosed: true });
  await db.query("update public.trade_accounts set status='approved', credit_limit_pence = 20000 where id=$1", [accountId]);
  expect(await (await submit(attempt)).json()).toMatchObject({ attemptClosed: true });
  expect(stripe.invoices.create).not.toHaveBeenCalled();
  expect(await position(accountId)).toEqual({ held_pence: 0, outstanding_pence: 0, available_credit_pence: 20000 });
});

it("preserves dispatch when partial and full payment arrive out of order, then records a refund without adding stock", async () => {
  const { buyer, accountId } = await openAccount();
  const variantId = await variant();
  const { orderId, invoice } = await placeOrder(buyer, variantId);
  const warehouse = await user("warehouse");
  await db.query("select public.start_picking($1,$2,$3)", [orderId, randomUUID(), warehouse.id]);
  await db.query("select public.dispatch_order($1,$2,$3,'Fixture Carrier','TRACK-NET30')", [orderId, randomUUID(), warehouse.id]);
  const orderState = async () => (await db.query(`
    select payment_status,fulfilment_status,tracking_number,dispatched_at,paid_pence,refunded_pence
    from public.orders where id=$1
  `, [orderId])).rows[0];
  const dispatched = await orderState();
  const partialId = allocate(invoice, 4_000);
  const partial = await event("invoice_payment.paid", partialId);
  expect(partial.stored.state).toBe("processed");
  expect(await position(accountId)).toEqual({ held_pence: 0, outstanding_pence: 8000, available_credit_pence: 12000 });
  expect(await orderState()).toEqual({ ...dispatched, payment_status: "partially_paid", paid_pence: 4000 });
  const intent = providerId("pi");
  captures.set(intent, { id: intent, status: "succeeded", amount_received: 8000, currency: "gbp", livemode: false, metadata: {} } as Stripe.PaymentIntent);
  const finalPayment = allocate(invoice, 8_000, intent);
  expect((await event("invoice.paid", invoice.id)).stored.state).toBe("processed");
  expect((await event("invoice_payment.paid", finalPayment)).stored.state).toBe("processed");
  expect((await event("invoice_payment.paid", partialId, partial.eventId)).stored.state).toBe("processed");
  expect(await orderState()).toEqual({ ...dispatched, payment_status: "paid", paid_pence: 12000 });
  expect(await position(accountId)).toEqual({ held_pence: 0, outstanding_pence: 0, available_credit_pence: 20000 });
  const refundId = providerId("re");
  refunds.set(refundId, { id: refundId, status: "succeeded", amount: 2_000, currency: "gbp", payment_intent: intent } as Stripe.Refund);
  expect((await event("refund.created", refundId)).stored.state).toBe("processed");
  expect(await orderState()).toEqual({ ...dispatched, payment_status: "partially_refunded", paid_pence: 12000, refunded_pence: 2000 });
  expect((await db.query("select stock_on_hand,stock_reserved from public.variants where id=$1", [variantId])).rows)
    .toEqual([{ stock_on_hand: 4, stock_reserved: 0 }]);
});

it("retains collectible debt until finance confirms void for a cancelled undispatched order", async () => {
  const { buyer, staff, accountId } = await openAccount();
  const variantId = await variant();
  const { invoice, orderId } = await placeOrder(buyer, variantId);
  await expect(voidCancelledNet30Invoice(orderId, staff.id)).rejects.toThrow("Only cancelled");
  const warehouse = await user("warehouse");
  await db.query("select public.cancel_order($1,$2,$3)", [orderId, randomUUID(), warehouse.id]);
  expect(await position(accountId)).toMatchObject({ outstanding_pence: 12000 });
  await expect(voidCancelledNet30Invoice(orderId, buyer.id)).rejects.toThrow("Only cancelled");
  await voidCancelledNet30Invoice(orderId, staff.id);
  await voidCancelledNet30Invoice(orderId, staff.id);
  expect(stripe.invoices.voidInvoice).toHaveBeenCalledOnce();
  expect((await event("invoice.voided", invoice.id)).stored.state).toBe("processed");
  expect(await position(accountId)).toEqual({ held_pence: 0, outstanding_pence: 0, available_credit_pence: 20000 });
  expect((await db.query("select stock_on_hand,stock_reserved from public.variants where id=$1", [variantId])).rows)
    .toEqual([{ stock_on_hand: 5, stock_reserved: 0 }]);
});

it("reconciles credit notes against overdue balances and preserves credit exposure for uncollectible invoices", async () => {
  const { buyer, accountId } = await openAccount();
  const { orderId, invoice } = await placeOrder(buyer);
  const noteId = providerId("cn");
  credits.set(noteId, {
    id: noteId, invoice: invoice.id, currency: "gbp", livemode: false, status: "issued",
    pre_payment_amount: 1000, post_payment_amount: 0, total: 1000,
  } as Stripe.CreditNote);
  invoice.pre_payment_credit_notes_amount = 1000;
  invoice.amount_due -= 1000;
  invoice.amount_remaining -= 1000;
  expect((await event("credit_note.created", noteId)).stored.state).toBe("processed");
  expect((await event("invoice.overdue", invoice.id)).stored.state).toBe("processed");
  invoice.status = "uncollectible";
  expect((await event("invoice.marked_uncollectible", invoice.id)).stored).toMatchObject({
    state: "failed", last_error: expect.stringContaining("Outstanding credit remains"),
  });
  await db.query("update public.orders set created_at=now()-interval '3 minutes' where id=$1", [orderId]);
  expect(await reconcileStripePayments()).toMatchObject({ unresolvedTradeOrders: expect.any(Number) });
  expect((await db.query("select stripe_reconciliation_error from public.orders where id=$1", [orderId])).rows[0])
    .toMatchObject({ stripe_reconciliation_error: expect.stringContaining("uncollectible") });
  expect(await position(accountId)).toEqual({ held_pence: 0, outstanding_pence: 11000, available_credit_pence: 9000 });
});
