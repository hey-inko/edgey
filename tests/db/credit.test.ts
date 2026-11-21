import { randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { approveTradeAccount, bindInvoice, createNet30OrderWithHolds, voidInvoice } from "@/lib/credit";
import { getVerifiedBuyer } from "@/lib/auth/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/server", () => ({ getVerifiedBuyer: vi.fn() }));

type Account = { id: string; stripe_customer_id: string };
type Order = { id: string; hold_expires_at: Date };

let connectionString: string;
let db: Client;

async function connect() {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3000, statement_timeout: 8000 });
  await client.connect();
  return client;
}

beforeAll(async () => {
  const url = process.env.SUPABASE_DB_URL;
  if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
    throw new Error("These tests need the local Supabase stack. Run pnpm db:start && pnpm db:env.");
  }
  connectionString = url;
  db = await connect();
});

afterAll(() => db?.end());

async function one<Row extends QueryResultRow>(sql: string, values: unknown[] = [], client = db) {
  const { rows } = await client.query<Row>(sql, values);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const rpc = <Row extends QueryResultRow = Order>(name: string, values: unknown[], client = db) =>
  one<Row>(`select * from public.${name}(${values.map((_, i) => `$${i + 1}`).join(", ")})`, values, client);

const stripeId = (prefix: string) => prefix + "_" + randomUUID().replaceAll("-", "");

async function user(options: { role?: "finance" | "warehouse"; verified?: boolean; anonymous?: boolean } = {}) {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await db.query("insert into auth.users (id, email, email_confirmed_at, is_anonymous) values ($1, $2, $3, $4)",
    [id, email, options.verified === false ? null : new Date(), options.anonymous ?? false]);
  if (options.role) await db.query("insert into public.staff_members (user_id, role) values ($1, $2)", [id, options.role]);
  return { id, email };
}

async function application(buyerId: string, financeId?: string) {
  const id = randomUUID();
  await rpc("submit_trade_application", [id, buyerId, "Named Buyer", "Fabrication Ltd", "1 Test Street", "London", "SW1A 1AA"]);
  if (financeId) await rpc("review_trade_application", [id, financeId, "approved"]);
  return id;
}

async function fixture(financeId: string, limit = 20000) {
  const buyer = await user();
  const applicationId = await application(buyer.id, financeId);
  const account = await rpc<Account>("approve_trade_account", [applicationId, financeId, limit, stripeId("cus")]);
  return { buyer, applicationId, account };
}

async function variant(productId = randomUUID(), stockOnHand = 3) {
  const id = randomUUID();
  await db.query(`
    insert into public.products (id, family_code, slug, name, tool_category)
    values ($1, $1::uuid::text, $1::uuid::text, 'Credit test family', 'oscillating') on conflict (id) do nothing
  `, [productId]);
  await db.query(`
    insert into public.variants (
      id, product_id, sku, option_label, supplier_part_number, evidence_source, approved_at, publication_status,
      price_1_4_pence, price_5_9_pence, price_10_plus_pence, stock_on_hand
    ) values ($1, $2, $1::uuid::text, '45°', $1::uuid::text, 'Credit fixture', now(), 'published', 10000, 9900, 9800, $3)
  `, [id, productId, stockOnHand]);
  return id;
}

function orderArgs(variantId: string, buyer: { id: string; email: string }, token: string, unitPrice = 10000) {
  return [
    token,
    JSON.stringify([{ variant_id: variantId, quantity: 1, unit_price_pence: unitPrice }]),
    JSON.stringify({ email: buyer.email, business_name: "Fabrication Ltd", recipient_name: "Named Buyer", buying_for_work: true }),
    JSON.stringify({ line1: "1 Test Street", town: "London", postcode: "SW1A 1AA", country: "GB" }),
    JSON.stringify({
      goods_net_pence: 10000, delivery_net_pence: 0, vat_rate_bps: 2000, vat_pence: 2000, gross_pence: 12000,
    }),
    new Date(Date.now() + 35 * 60 * 1000),
    "Standard",
    "2099-01-05",
    "2099-01-06",
    buyer.id,
  ];
}

function hold(variantId: string, buyer: { id: string; email: string }, {
  token = randomUUID(), po = "PO-120", unitPrice = 10000,
} = {}, client = db) {
  return rpc("create_net30_order_with_holds", [...orderArgs(variantId, buyer, token, unitPrice), po], client);
}

const inPast = { issued: "2020-01-02T12:00:00Z", due: "2020-02-01T12:00:00Z" };
function bind(order: Order, account: Account, providerId: string, {
  gross = 12000, currency = "GBP", dates = inPast,
} = {}, client = db) {
  return rpc("bind_invoice", [
    order.id, providerId, account.stripe_customer_id, gross, currency, dates.issued, dates.due, "2099-01-06", "2099-01-07",
  ], client);
}

const stock = (id: string) => one("select stock_on_hand, stock_reserved from public.variants where id = $1", [id]);

async function position(account: Account, held: number, outstanding: number, available: number) {
  expect(await one(`
    select held_pence::int, outstanding_pence::int, available_credit_pence::int
    from public.trade_credit_position where trade_account_id = $1
  `, [account.id])).toEqual({ held_pence: held, outstanding_pence: outstanding, available_credit_pence: available });
  expect(await one(`
    select coalesce(sum(held_delta_pence), 0)::int as held_pence,
      coalesce(sum(outstanding_delta_pence), 0)::int as outstanding_pence
    from public.credit_ledger where trade_account_id = $1
  `, [account.id])).toEqual({ held_pence: held, outstanding_pence: outstanding });
}

async function reject(run: () => Promise<unknown>, message?: string, code = "22023") {
  await db.query("savepoint credit_error");
  try {
    await expect(run()).rejects.toMatchObject(message ? { code, message } : { code });
  } finally {
    await db.query("rollback to savepoint credit_error");
    await db.query("release savepoint credit_error");
  }
}

async function asRole(role: "anon" | "authenticated" | "service_role", id: string | null, run: () => Promise<void>) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, sub: id })]);
  await db.query(`set local role ${role}`);
  try {
    await run();
  } finally {
    await db.query("reset role");
  }
}

async function cleanup(account: Account | undefined, applicationId: string, productId: string, userIds: string[]) {
  await db.query("begin");
  try {
    if (account) {
      for (const table of ["credit_ledger", "credit_holds", "invoices"]) {
        await db.query(`delete from public.${table} where trade_account_id = $1`, [account.id]);
      }
      for (const table of ["private.order_operations", "public.order_outbox", "public.stock_movements",
        "public.stock_reservations", "public.order_items"]) {
        await db.query(`delete from ${table} where order_id in (
          select id from public.orders where trade_account_id = $1
        )`, [account.id]);
      }
      await db.query("delete from public.orders where trade_account_id = $1", [account.id]);
      await db.query("delete from public.trade_accounts where id = $1", [account.id]);
    }
    await db.query("delete from public.trade_applications where id = $1", [applicationId]);
    await db.query("delete from auth.users where id = any($1::uuid[])", [userIds]);
    await db.query("delete from public.variants where product_id = $1", [productId]);
    await db.query("delete from public.products where id = $1", [productId]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

describe("trade credit transactions", () => {
  beforeEach(() => db.query("begin"));
  afterEach(() => db.query("rollback"));

  test("requires a separately approved application, a verified buyer, finance and enough gross credit", async () => {
    const finance = await user({ role: "finance" });
    const buyer = await user();
    const unverified = await user({ verified: false });
    const anonymous = await user({ anonymous: true });
    const item = await variant();
    const applicationId = await application(buyer.id);
    const customer = stripeId("cus");
    const approve = (actor: string, limit = 11999) =>
      rpc<Account>("approve_trade_account", [applicationId, actor, limit, customer]);

    await reject(() => hold(item, unverified), "verified_buyer_required", "42501");
    await reject(() => hold(item, anonymous), "verified_buyer_required", "42501");
    await reject(() => hold(item, buyer), "approved_trade_account_required", "42501");
    await reject(() => approve(finance.id), "approved_trade_application_required");
    await rpc("review_trade_application", [applicationId, finance.id, "approved"]);
    await reject(() => hold(item, buyer), "approved_trade_account_required", "42501");
    await reject(() => approve(buyer.id), "finance_role_required", "42501");
    const account = await approve(finance.id);
    expect(account).toMatchObject({ buyer_id: buyer.id, buyer_name: "Named Buyer", status: "approved" });
    await reject(() => hold(item, buyer, { po: " \t\n " }), "po_number_required");
    const token = randomUUID();
    await reject(() => hold(item, buyer, { token }), "insufficient_trade_credit", "P0001");
    expect((await db.query("select id from public.orders where checkout_attempt_token = $1", [token])).rowCount).toBe(0);
    expect(await stock(item)).toMatchObject({ stock_reserved: 0 });
    await reject(() => hold(item, buyer, { unitPrice: 9999 }), "stale_unit_price");

    const setLimit = (actor: string, limit: number) => rpc("set_credit_limit", [account.id, actor, "limit-op", limit]);
    await reject(() => setLimit(buyer.id, 30000), "finance_role_required", "42501");
    expect(await setLimit(finance.id, 12000)).toMatchObject({ credit_limit_pence: 12000 });
    expect(await setLimit(finance.id, 12000)).toMatchObject({ credit_limit_pence: 12000 });
    await reject(() => setLimit(finance.id, 20000), "operation_key_conflict");
    expect(await approve(finance.id)).toMatchObject({ id: account.id, credit_limit_pence: 12000 });
    const order = await hold(item, buyer, { token, po: " PO-120 " });
    expect(order).toMatchObject({ po_number: "PO-120", gross_pence: 12000, payment_method: "net30" });
    await position(account, 12000, 0, 0);
    await reject(() => hold(item, buyer, { token, po: "Changed PO" }), "attempt_payload_mismatch");
    await reject(() => rpc("create_order_with_reservations", orderArgs(item, buyer, token)), "attempt_payment_method_mismatch");
    await reject(() => rpc("release_reservation", [order.id, "bad-release", "closed"]), "net30_requires_credit_hold_release");
    await rpc("set_credit_limit", [account.id, finance.id, "reduce-limit", 10000]);
    await position(account, 12000, 0, 0);
    const suspend = () => rpc("suspend_trade_account", [account.id, finance.id, "suspend", "Risk review"]);
    expect(await suspend()).toMatchObject({ status: "suspended" });
    expect(await suspend()).toMatchObject({ status: "suspended" });
    await reject(() => hold(item, buyer), "approved_trade_account_required", "42501");
    expect(await hold(item, buyer, { token })).toMatchObject({ id: order.id });
    expect(await bind(order, account, stripeId("in"))).toMatchObject({ payment_status: "invoiced" });
    await position(account, 0, 12000, 0);
  });

  test("reconciles a provider timeout and a lost bind response to one invoice, PO, exposure and confirmation", async () => {
    const finance = await user({ role: "finance" });
    const { buyer, account } = await fixture(finance.id);
    const item = await variant();
    const token = randomUUID();
    const order = await hold(item, buyer, { token });
    const providerInvoices = new Map<string, string>();
    function issueAtProvider(orderId: string, timeout = false) {
      if (!providerInvoices.has(orderId)) providerInvoices.set(orderId, stripeId("in"));
      if (timeout) throw new Error("Provider response timed out after issue");
      return providerInvoices.get(orderId)!;
    }
    expect(() => issueAtProvider(order.id, true)).toThrow("timed out");
    await position(account, 12000, 0, 8000);
    const retry = await hold(item, buyer, { token });
    expect(retry.id).toBe(order.id);
    const providerId = issueAtProvider(retry.id);
    await reject(() => bind(retry, account, providerId, { gross: 12001 }), "invoice_amount_or_currency_mismatch");
    await reject(() => bind(retry, account, providerId, { currency: "USD" }), "invoice_amount_or_currency_mismatch");
    await reject(() => bind(retry, { ...account, stripe_customer_id: stripeId("cus") }, providerId),
      "invoice_provider_identity_mismatch");
    await position(account, 12000, 0, 8000);
    await bind(retry, account, providerId);
    expect(await bind(retry, account, issueAtProvider(retry.id))).toMatchObject({
      id: order.id, payment_status: "invoiced", fulfilment_status: "ready_to_pick", provider_invoice_id: providerId,
      authorised_at: new Date(inPast.issued),
    });
    await reject(() => bind(retry, account, stripeId("in")), "invoice_does_not_match_hold");
    await reject(() => bind(retry, account, providerId, { dates: { ...inPast, due: "2020-02-02T12:00:00Z" } }),
      "operation_key_conflict");
    expect(providerInvoices.size).toBe(1);
    await position(account, 0, 12000, 8000);
    expect(await one("select order_id, po_number, amount_remaining_pence from public.invoices where trade_account_id = $1",
      [account.id])).toEqual({ order_id: order.id, po_number: "PO-120", amount_remaining_pence: 12000 });
    expect(await one("select checkout_attempt_token, po_number from public.orders where trade_account_id = $1",
      [account.id])).toEqual({ checkout_attempt_token: token, po_number: "PO-120" });
    expect(await one("select message_key from public.order_outbox where order_id = $1", [order.id]))
      .toEqual({ message_key: "order_confirmation" });
  });

  test("dispatches unpaid, then settles and refunds without rewriting dispatch or restoring stock", async () => {
    const finance = await user({ role: "finance" });
    const warehouse = await user({ role: "warehouse" });
    const { buyer, account } = await fixture(finance.id);
    const item = await variant();
    const order = await hold(item, buyer);
    const invoiceId = stripeId("in");
    await bind(order, account, invoiceId);
    await rpc("start_picking", [order.id, "pick", warehouse.id]);
    const shipping = {
      fulfilment_status: "dispatched",
      carrier: "Test Carrier",
      tracking_number: "TRACK-30",
    };
    const dispatched = await rpc<{ dispatched_at: Date }>("dispatch_order", [
      order.id, "dispatch", warehouse.id, shipping.carrier, shipping.tracking_number,
    ]);
    expect(dispatched).toMatchObject({ ...shipping, payment_status: "invoiced", dispatched_at: expect.any(Date) });
    const orderState = () => one("select * from public.orders where id = $1", [order.id]);
    const payment = (key: string, amount: number) => rpc("apply_invoice_payment", [invoiceId, key, amount, "gbp"]);
    const note = (key: string, amount: number, prePayment: number) =>
      rpc("apply_credit_note", [invoiceId, key, amount, prePayment, "GBP"]);

    await position(account, 0, 12000, 8000);
    const overdue = () => db.query("select order_id from public.overdue_invoices where trade_account_id = $1", [account.id]);
    expect((await overdue()).rows).toEqual([{ order_id: order.id }]);
    expect(await payment("payment-1", 4000)).toMatchObject({ amount_remaining_pence: 8000, status: "partially_paid" });
    expect(await payment("payment-1", 4000)).toMatchObject({ amount_remaining_pence: 8000 });
    await reject(() => payment("payment-1", 4001), "operation_key_conflict");
    await reject(() => payment("payment-too-high", 8001), "invoice_adjustment_exceeds_amount_remaining");
    expect(await orderState()).toMatchObject({ ...shipping, dispatched_at: dispatched.dispatched_at,
      payment_status: "partially_paid", paid_pence: 4000 });
    await position(account, 0, 8000, 12000);

    expect(await note("credit-note", 1000, 1000)).toMatchObject({ amount_remaining_pence: 7000 });
    expect(await note("credit-note", 1000, 1000)).toMatchObject({ amount_remaining_pence: 7000 });
    await position(account, 0, 7000, 13000);
    expect(await payment("payment-2", 7000)).toMatchObject({ amount_remaining_pence: 0, status: "paid" });
    expect(await payment("payment-1", 4000)).toMatchObject({ amount_remaining_pence: 0, status: "paid" });
    expect((await overdue()).rowCount).toBe(0);
    await position(account, 0, 0, 20000);
    expect(await orderState()).toMatchObject({ ...shipping, dispatched_at: dispatched.dispatched_at,
      payment_status: "paid", paid_pence: 11000 });

    await note("post-payment-note", 2000, 0);
    await reject(() => note("more-than-original", 9001, 0), "credit_note_exceeds_invoice_amounts");
    const refund = () => rpc("apply_invoice_refund", [invoiceId, "refund-1", 2000, "GBP"]);
    await refund();
    await refund();
    expect(await orderState()).toMatchObject({ ...shipping, dispatched_at: dispatched.dispatched_at,
      payment_status: "partially_refunded", refunded_pence: 2000 });
    await position(account, 0, 0, 20000);
    expect(await stock(item)).toEqual({ stock_on_hand: 2, stock_reserved: 0 });
    expect((await db.query("select kind from public.stock_movements where order_id = $1 order by id", [order.id])).rows)
      .toEqual([{ kind: "reserve" }, { kind: "dispatch" }]);
  });

  test("distinguishes full credit from cash settlement and requires refunds before a partially paid void", async () => {
    const finance = await user({ role: "finance" });
    const { buyer, account } = await fixture(finance.id);
    const item = await variant();
    const order = await hold(item, buyer);
    const providerId = stripeId("in");
    await bind(order, account, providerId);
    await reject(() => rpc("apply_credit_note", [providerId, "invalid-split", 100, 101, "GBP"]), "invalid_credit_note_split");
    await reject(() => rpc("apply_credit_note", [providerId, "premature-post-credit", 100, 0, "GBP"]),
      "credit_note_exceeds_invoice_amounts");
    const fullCredit = () => rpc("apply_credit_note", [providerId, "all-credit", 12000, 12000, "GBP"]);
    expect(await fullCredit()).toMatchObject({ status: "credited", amount_remaining_pence: 0 });
    expect(await fullCredit()).toMatchObject({ status: "credited", amount_remaining_pence: 0 });
    expect(await one("select payment_status, fulfilment_status, paid_pence from public.orders where id = $1", [order.id]))
      .toEqual({ payment_status: "voided", fulfilment_status: "cancelled", paid_pence: 0 });
    await position(account, 0, 0, 20000);
    expect(await stock(item)).toEqual({ stock_on_hand: 3, stock_reserved: 0 });

    const second = await hold(item, buyer);
    const partiallyPaid = stripeId("in");
    await bind(second, account, partiallyPaid);
    await rpc("apply_invoice_payment", [partiallyPaid, "partial-before-void", 5000, "GBP"]);
    await reject(() => rpc("void_invoice", [partiallyPaid]), "invoice_has_unrefunded_payments");
    await position(account, 0, 7000, 13000);
    await rpc("apply_invoice_refund", [partiallyPaid, "refund-before-void", 5000, "GBP"]);
    expect(await rpc("void_invoice", [partiallyPaid])).toMatchObject({ status: "voided", amount_remaining_pence: 0 });
    await position(account, 0, 0, 20000);
  });

  test("releases an abandoned hold and cancels a bound order only on verified financial transitions", async () => {
    const finance = await user({ role: "finance" });
    const warehouse = await user({ role: "warehouse" });
    const { buyer, account } = await fixture(finance.id);
    const item = await variant();
    const unissued = await hold(item, buyer);
    const release = () => rpc("release_credit_hold", [unissued.id, "release-unissued", "not_created"]);
    expect(await release()).toMatchObject({ payment_status: "voided", fulfilment_status: "cancelled" });
    expect(await release()).toMatchObject({ payment_status: "voided", fulfilment_status: "cancelled" });
    expect(await stock(item)).toEqual({ stock_on_hand: 3, stock_reserved: 0 });
    await position(account, 0, 0, 20000);

    const issued = await hold(item, buyer);
    const providerId = stripeId("in");
    await bind(issued, account, providerId);
    await reject(() => rpc("release_credit_hold", [issued.id, "wrong-release", "not_created"]), "credit_hold_not_releasable");
    await rpc("start_picking", [issued.id, "pick", warehouse.id]);
    await rpc("cancel_order", [issued.id, "cancel", warehouse.id]);
    expect(await stock(item)).toEqual({ stock_on_hand: 3, stock_reserved: 0 });
    await position(account, 0, 12000, 8000);
    expect(await rpc("void_invoice", [providerId])).toMatchObject({ status: "voided", amount_remaining_pence: 0 });
    expect(await rpc("void_invoice", [providerId])).toMatchObject({ status: "voided", amount_remaining_pence: 0 });
    await position(account, 0, 0, 20000);

    const providerFirst = await hold(item, buyer);
    const providerFirstId = stripeId("in");
    await bind(providerFirst, account, providerFirstId);
    await rpc("void_invoice", [providerFirstId]);
    expect(await one("select fulfilment_status, payment_status from public.orders where id = $1", [providerFirst.id]))
      .toEqual({ fulfilment_status: "cancelled", payment_status: "voided" });
    await position(account, 0, 0, 20000);
    expect(await stock(item)).toEqual({ stock_on_hand: 3, stock_reserved: 0 });

    const alreadyVoided = await hold(item, buyer);
    const voidedId = stripeId("in");
    await rpc("release_credit_hold", [alreadyVoided.id, "voided-before-bind", "voided", voidedId]);
    await reject(() => bind(alreadyVoided, account, voidedId), "invoice_already_closed");
    await position(account, 0, 0, 20000);

    const lateInvoice = stripeId("in");
    expect(await bind(unissued, account, lateInvoice)).toMatchObject({
      fulfilment_status: "cancelled", authorised_at: null, payment_review_reason: "invoice_issued_after_hold_released",
    });
    await position(account, 0, 12000, 8000);
    expect(await stock(item)).toEqual({ stock_on_hand: 3, stock_reserved: 0 });
    expect((await db.query("select id from public.order_outbox where order_id = $1", [unissued.id])).rowCount).toBe(0);
  });

  test("leaves card invoices outside the trade tables and blocks method changes on replay", async () => {
    const finance = await user({ role: "finance" });
    const { buyer, account } = await fixture(finance.id);
    const item = await variant();
    const token = randomUUID();
    const order = await rpc("create_order_with_reservations", orderArgs(item, buyer, token));
    const invoiceId = stripeId("in");
    await reject(() => hold(item, buyer, { token }), "attempt_payment_method_mismatch");
    await reject(() => bind(order, account, invoiceId), "net30_order_not_found", "P0002");
    await rpc("confirm_payment", [
      order.id, "cs_credit_test", "pi_credit_test", 12000, "GBP", inPast.issued, "2099-01-06", "2099-01-07", invoiceId,
    ]);
    await reject(() => rpc("apply_invoice_payment", [invoiceId, "op-card", 12000, "GBP"]), "trade_invoice_not_found", "P0002");
    await position(account, 0, 0, 20000);
    expect((await db.query("select order_id from public.credit_ledger where order_id = $1", [order.id])).rowCount).toBe(0);
  });

  test("keeps invoice, position and order reads buyer-scoped and credit writes finance/service-only", async () => {
    const finance = await user({ role: "finance" });
    const { buyer, account } = await fixture(finance.id);
    const other = await fixture(finance.id);
    const item = await variant();
    const own = await hold(item, buyer);
    const foreign = await hold(item, other.buyer);
    await bind(own, account, stripeId("in"));
    await bind(foreign, other.account, stripeId("in"));
    await asRole("authenticated", buyer.id, async () => {
      expect((await db.query("select id from public.trade_accounts")).rows).toEqual([{ id: account.id }]);
      expect((await db.query("select trade_account_id from public.trade_credit_position")).rows)
        .toEqual([{ trade_account_id: account.id }]);
      expect((await db.query("select order_id from public.invoices")).rows).toEqual([{ order_id: own.id }]);
      expect((await db.query("select order_id from public.credit_holds")).rows).toEqual([{ order_id: own.id }]);
      expect((await db.query("select id from public.orders where id = any($1::uuid[])", [[own.id, foreign.id]])).rows)
        .toEqual([{ id: own.id }]);
      expect((await db.query("select order_id from public.order_items where order_id = any($1::uuid[])", [[own.id, foreign.id]])).rows)
        .toEqual([{ order_id: own.id }]);
      expect((await db.query("select id from public.credit_ledger")).rowCount).toBe(0);
      await reject(() => db.query("select provider_invoice_id from public.invoices"), undefined, "42501");
      await reject(() => db.query("select stripe_customer_id from public.trade_accounts"), undefined, "42501");
      await reject(() => db.query("select order_id from public.overdue_invoices"), undefined, "42501");
      await reject(() => db.query("update public.trade_accounts set credit_limit_pence = 30000"), undefined, "42501");
      await reject(() => rpc("set_credit_limit", [account.id, finance.id, "spoofed-actor", 30000]), undefined, "42501");
    });
    await asRole("authenticated", finance.id, async () => {
      expect((await db.query("select id from public.credit_ledger")).rowCount).toBe(6);
      await reject(() => db.query("update public.trade_accounts set credit_limit_pence = 30000"), undefined, "42501");
    });
    await asRole("anon", null, async () => {
      for (const table of ["trade_accounts", "trade_credit_position", "credit_holds", "invoices", "credit_ledger"]) {
        await reject(() => db.query(`select 1 from public.${table}`), undefined, "42501");
      }
    });
    await asRole("service_role", null, async () => {
      expect(await rpc("set_credit_limit", [account.id, finance.id, "legit-op", 30000]))
        .toMatchObject({ credit_limit_pence: 30000 });
      await reject(() => db.query("update public.trade_accounts set credit_limit_pence = 30000"), undefined, "42501");
      await reject(() => db.query("delete from public.credit_ledger"), undefined, "42501");
      expect((await db.query("select order_id from public.overdue_invoices")).rowCount).toBe(2);
    });
  });

  test("grants fixed-search-path credit RPCs only to the service role", async () => {
    const names = [
      "apply_credit_note", "apply_invoice_payment", "apply_invoice_refund", "approve_trade_account", "bind_invoice",
      "create_net30_order_with_holds", "release_credit_hold", "set_credit_limit", "suspend_trade_account", "void_invoice",
    ];
    const { rows } = await db.query(`
      select p.proname as name, p.prosecdef as definer, p.proconfig as config,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[]) order by name
    `, [names]);
    expect(rows).toEqual(names.map((name) => ({
      name, definer: true, config: ['search_path=""'], anon: false, authenticated: false, service: true,
    })));
  });
});

test.each([
  { isolation: "read committed", replay: false },
  { isolation: "repeatable read", replay: false },
  { isolation: "read committed", replay: true },
])("serializes £120 checkouts against £200 ($isolation, same attempt: $replay)", async ({ isolation, replay }) => {
  const finance = await user({ role: "finance" });
  const { buyer, account, applicationId } = await fixture(finance.id);
  const productId = randomUUID();
  const token = randomUUID();
  const tokens = [token, replay ? token : randomUUID()];
  const workers: Client[] = [];
  try {
    const items = [await variant(productId), await variant(productId)];
    for (let i = 0; i < 2; i++) workers.push(await connect());
    const pids = await Promise.all(workers.map(async (client) => {
      await client.query(`begin isolation level ${isolation}`);
      await client.query("set local role service_role");
      return (await one<{ pid: number }>("select pg_backend_pid() as pid", [], client)).pid;
    }));
    const { pid: barrier } = await one<{ pid: number }>("select pg_backend_pid() as pid");
    await db.query("begin");
    let results: Promise<PromiseSettledResult<Order>[]> | undefined;
    try {
      await db.query("select id from public.trade_accounts where id = $1 for update", [account.id]);
      results = Promise.allSettled(workers.map(async (client, i) => {
        try {
          const order = await hold(items[replay ? 0 : i]!, buyer, { token: tokens[i]!, po: replay ? "PO-replay" : `PO-${i}` }, client);
          await client.query("commit");
          return order;
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }));
      await expect.poll(async () => {
        const { rows } = await db.query<{ blockers: number[] }>(`
          select pg_blocking_pids(pid) as blockers from unnest($1::int[]) as pid
        `, [pids]);
        return rows.every(({ blockers }) => blockers.length > 0) &&
          rows.some(({ blockers }) => blockers.includes(barrier));
      }, { timeout: 4000 }).toBe(true);
    } finally {
      await db.query("rollback");
      await results;
    }
    const outcomes = await results;
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", replay ? "fulfilled" : "rejected"]);
    if (replay) {
      const [initial, retry] = outcomes;
      expect(retry).toEqual(initial);
    } else {
      const loser = outcomes.find((outcome) => outcome.status === "rejected")!;
      expect(loser.reason).toMatchObject(isolation === "read committed"
        ? { code: "P0001", message: "insufficient_trade_credit" } : { code: "40001" });
    }
    expect((await db.query("select id from public.orders where trade_account_id = $1", [account.id])).rowCount).toBe(1);
    const reserved = await Promise.all(items.map(stock));
    expect(reserved).toEqual(expect.arrayContaining([
      { stock_on_hand: 3, stock_reserved: 1 }, { stock_on_hand: 3, stock_reserved: 0 },
    ]));
    await position(account, 12000, 0, 8000);
  } finally {
    await Promise.all(workers.map((client) => client.end()));
    await cleanup(account, applicationId, productId, [buyer.id, finance.id]);
  }
});

test("concurrent voids and dispatches on one variant preserve the stock and credit ledgers", async () => {
  const finance = await user({ role: "finance" });
  const warehouse = await user({ role: "warehouse" });
  const { buyer, account, applicationId } = await fixture(finance.id, 144000);
  const productId = randomUUID();
  const workers: Client[] = [];
  try {
    const count = 12;
    const item = await variant(productId, count);
    const orders: { order: Order; invoiceId: string }[] = [];
    for (let i = 0; i < count; i++) {
      const order = await hold(item, buyer);
      const invoiceId = stripeId("in");
      await bind(order, account, invoiceId);
      await rpc("start_picking", [order.id, "pick", warehouse.id]);
      orders.push({ order, invoiceId });
      workers.push(await connect());
    }
    await Promise.all(workers.map((client) => client.query("set role service_role")));
    const outcomes = await Promise.allSettled(workers.map((client, i) => {
      const { order, invoiceId } = orders[i]!;
      return i % 2 === 0
        ? rpc("void_invoice", [invoiceId], client)
        : rpc("dispatch_order", [order.id, "dispatch", warehouse.id, "Test Carrier", "TRACK"], client);
    }));
    expect(outcomes.filter((result) => result.status === "rejected")).toEqual([]);
    expect(await stock(item)).toEqual({ stock_on_hand: 6, stock_reserved: 0 });
    expect(await one(`
      select count(*) filter (where kind = 'release')::int as released,
        count(*) filter (where kind = 'dispatch')::int as dispatched,
        sum(reserved_delta)::int as reserved_delta
      from public.stock_movements where variant_id = $1
    `, [item])).toEqual({ released: 6, dispatched: 6, reserved_delta: 0 });
    await position(account, 0, 72000, 72000);
  } finally {
    await Promise.all(workers.map((client) => client.end()));
    await cleanup(account, applicationId, productId, [buyer.id, finance.id, warehouse.id]);
  }
});

test("concurrent bind and provider-close updates converge without reviving a closed invoice", async () => {
  const finance = await user({ role: "finance" });
  const { buyer, account, applicationId } = await fixture(finance.id);
  const productId = randomUUID();
  const workers: Client[] = [];
  try {
    const item = await variant(productId);
    const order = await hold(item, buyer);
    const invoiceId = stripeId("in");
    workers.push(await connect(), await connect());
    await Promise.all(workers.map((client) => client.query("set role service_role")));
    const [issue, release] = await Promise.allSettled([
      bind(order, account, invoiceId, {}, workers[0]),
      rpc("release_credit_hold", [order.id, "concurrent-close", "voided", invoiceId], workers[1]),
    ]);
    if (issue.status === "fulfilled") {
      expect(release).toMatchObject({ status: "rejected", reason: { message: "credit_hold_not_releasable" } });
      const payment = (worker: Client) => rpc("apply_invoice_payment", [invoiceId, "concurrent-payment", 2000, "GBP"], worker);
      for (const invoice of await Promise.all(workers.map(payment))) {
        expect(invoice).toMatchObject({ status: "partially_paid", amount_remaining_pence: 10000 });
      }
      await position(account, 0, 10000, 10000);
      expect(await stock(item)).toEqual({ stock_on_hand: 3, stock_reserved: 1 });
    } else {
      expect(issue.reason).toMatchObject({ message: "invoice_already_closed" });
      expect(release).toMatchObject({ status: "fulfilled", value: { fulfilment_status: "cancelled" } });
      await position(account, 0, 0, 20000);
      expect(await stock(item)).toEqual({ stock_on_hand: 3, stock_reserved: 0 });
    }
  } finally {
    await Promise.all(workers.map((client) => client.end()));
    await cleanup(account, applicationId, productId, [buyer.id, finance.id]);
  }
});

test("the server wrapper uses the verified identity and calls the real local PostgREST RPCs", async () => {
  const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!apiUrl || !["localhost", "127.0.0.1"].includes(new URL(apiUrl).hostname)) {
    throw new Error("These tests need the local Supabase API. Run pnpm db:env.");
  }
  const finance = await user({ role: "finance" });
  const buyer = await user();
  const applicationId = await application(buyer.id, finance.id);
  const productId = randomUUID();
  const customerId = stripeId("cus");
  let account: Account | undefined;
  try {
    const item = await variant(productId);
    const input = {
      attemptToken: randomUUID(),
      lines: [{ variantId: item, quantity: 1, unitPricePence: 10000 }],
      contact: { email: buyer.email, businessName: "Fabrication Ltd", recipientName: "Named Buyer", buyingForWork: true },
      address: { line1: "1 Test Street", town: "London", postcode: "SW1A 1AA", country: "GB" },
      totals: { goodsNetPence: 10000, deliveryNetPence: 0, vatRateBps: 2000, vatPence: 2000, grossPence: 12000 },
      holdExpiresAt: new Date(Date.now() + 35 * 60 * 1000).toISOString(),
      deliveryService: "Standard",
      promise: { dispatchDate: "2099-01-05", deliveryDate: "2099-01-06" },
      poNumber: "PO-wrapper",
    } as const;
    vi.mocked(getVerifiedBuyer).mockResolvedValue(null);
    await expect(createNet30OrderWithHolds(input)).rejects.toThrow("A verified session is required");
    const approval = { applicationId, creditLimitPence: 20000, stripeCustomerId: customerId };
    vi.mocked(getVerifiedBuyer).mockResolvedValue(buyer);
    await expect(approveTradeAccount(approval)).rejects.toMatchObject({ code: "42501", message: "finance_role_required" });
    vi.mocked(getVerifiedBuyer).mockResolvedValue(finance);
    const approved = await approveTradeAccount(approval);
    account = { id: approved.id, stripe_customer_id: customerId };
    vi.mocked(getVerifiedBuyer).mockResolvedValue(buyer);
    const order = await createNet30OrderWithHolds(input);
    expect(order).toMatchObject({ buyer_id: buyer.id, po_number: input.poNumber, payment_method: "net30" });
    const providerInvoiceId = stripeId("in");
    expect(await bindInvoice({
      orderId: order.id, providerInvoiceId, stripeCustomerId: customerId, amountDuePence: 12000, currency: "GBP",
      issuedAt: inPast.issued, dueAt: inPast.due, promise: input.promise,
    })).toMatchObject({ fulfilment_status: "ready_to_pick", payment_status: "invoiced" });
    expect(await voidInvoice(providerInvoiceId)).toMatchObject({ order_id: order.id, status: "voided", amount_remaining_pence: 0 });
    await position(account, 0, 0, 20000);
  } finally {
    vi.mocked(getVerifiedBuyer).mockReset();
    await cleanup(account, applicationId, productId, [buyer.id, finance.id]);
  }
});
