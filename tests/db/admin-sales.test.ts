import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { accountEmail, connectAccountDb, createAccountBuyer, createAccountCatalogue, createAccountOrder } from "../helpers/account-fixture";
import { setDbClaims } from "../helpers/db-claims";

type StaffRole = "warehouse" | "catalogue" | "finance";
type DatabaseRole = "anon" | "authenticated" | "service_role";
type Metrics = {
  revenuePence: number; vatPence: number; deliveryPence: number; orders: number;
  units: number; refundsPence: number; creditsPence: number;
};
type Kpi = Metrics & { aovPence: number | null; marginPence: number | null; marginBps: number | null };
type Product = { id: string; shareBps: number | null };
type Split = { key: string; units: number; revenuePence: number; orders?: number };
type Report = {
  canSeeMargin: boolean; current: Kpi; previous: Kpi;
  daily: (Metrics & { date: string })[]; series: (Metrics & { date: string })[];
  products: Product[]; tiers: Split[]; payments: Split[];
  buyers: { new: number; returning: number };
};

let db: Client;
beforeAll(async () => { db = await connectAccountDb(); });
afterAll(() => db?.end());
beforeEach(() => db.query("begin"));
afterEach(() => db.query("rollback"));

async function staff(...roles: StaffRole[]) {
  const { id } = await createAccountBuyer(db);
  for (const role of roles) await db.query("insert into public.staff_members (user_id, role) values ($1, $2)", [id, role]);
  return id;
}

async function as<T>(
  role: DatabaseRole, user: string | null, run: () => Promise<T>,
  assurance: boolean | { sessionId: string; method: "password" | "otp" },
): Promise<T> {
  await db.query("savepoint sales_test");
  try {
    if (typeof assurance === "boolean") {
      await setDbClaims(db, role, user, assurance);
    } else {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        role, sub: user, aal: "aal2", session_id: assurance.sessionId, amr: [{ method: assurance.method }, { method: "totp" }],
      })]);
    }
    await db.query(`set local role ${role}`);
    return await run();
  } catch (error) {
    await db.query("rollback to savepoint sales_test");
    throw error;
  } finally {
    await db.query("reset role");
    await db.query("release savepoint sales_test");
  }
}

async function getReport(...args: (string | null)[]) {
  const { rows } = await db.query<{ report: Report }>(
    `select public.admin_sales_report(${args.map((_, i) => `$${i + 1}`).join(", ")}) as report`, args,
  );
  return rows[0]!.report;
}

const report = (id: string, ...args: (string | null)[]) =>
  as("authenticated", id, () => getReport(...args), true);

const cost = (landed: number) => JSON.stringify({
  supplier_unit_minor: landed, currency: "GBP", landed_unit_pence: landed,
});
const line = (item: { id: string; sku: string; label: string }, quantity = 1, price = 1000) => ({ ...item, quantity, price });

async function booking(date: string, lines: ReturnType<typeof line>[], options: {
  buyerId?: string; email?: string; state?: "pending" | "dispatched" | "refunded";
} = {}) {
  return (await createAccountOrder(db, {
    buyerId: options.buyerId ?? null, email: options.email ?? accountEmail(),
    state: options.state ?? "dispatched", createdAt: date, lines,
  })).id;
}

async function cardRefund(id: string, amount: number, date: string) {
  const intent = `pi_${id.replaceAll("-", "")}`;
  const refund = `re_${randomUUID().replaceAll("-", "")}`;
  await db.query("update public.orders set payment_intent_id = $2 where id = $1", [id, intent]);
  for (let i = 0; i < 2; i++) {
    await db.query("select public.record_refund($1, $2, $3, $4, 'GBP')", [id, refund, intent, amount]);
  }
  await db.query("update private.order_operations set created_at = $2 where operation_key = $1 and action = 'refund'", [refund, date]);
}

async function tradeAccount(buyerId: string) {
  const applicationId = randomUUID();
  await db.query(`
    insert into public.trade_applications (id, buyer_id, email, buyer_name, company, billing_line1, billing_town, billing_postcode)
    values ($1, $2, $3, 'Test buyer', 'Test company', '1 Test Lane', 'London', 'SW1A 1AA')
  `, [applicationId, buyerId, accountEmail()]);
  const { rows } = await db.query<{ id: string }>(`
    insert into public.trade_accounts (application_id, buyer_id, buyer_name, status, credit_limit_pence, stripe_customer_id)
    values ($1, $2, 'Test buyer', 'approved', 50000, $3) returning id
  `, [applicationId, buyerId, `cus_${applicationId.replaceAll("-", "")}`]);
  return rows[0]!.id;
}

async function invoice(orderId: string, accountId: string, dispatch = true) {
  const providerId = `in_${orderId.replaceAll("-", "")}`;
  await db.query(`
    update public.orders set payment_method = 'net30', payment_status = 'invoiced', paid_pence = 0, po_number = 'PO-42',
      trade_account_id = $2, provider_invoice_id = $3,
      fulfilment_status = case when $4 then 'dispatched' else 'ready_to_pick' end::public.order_fulfilment_status,
      dispatched_at = case when $4 then dispatched_at end
    where id = $1
  `, [orderId, accountId, providerId, dispatch]);
  await db.query(`
    insert into public.invoices (order_id, trade_account_id, provider_invoice_id, po_number, currency,
      amount_due_pence, amount_remaining_pence, issued_at, due_at)
    select id, trade_account_id, provider_invoice_id, po_number, currency,
      gross_pence, gross_pence, authorised_at, authorised_at + interval '30 days'
    from public.orders where id = $1
  `, [orderId]);
  return providerId;
}

test("requires authenticated staff with an approved password-backed AAL2 session", async () => {
  const finance = await staff("finance");
  const warehouse = await staff("warehouse");
  const catalogue = await staff("catalogue");
  const buyer = await staff();
  const query = () => getReport("2025-03-29", "2025-03-29");
  expect((await as("authenticated", finance, query, true)).canSeeMargin).toBe(true);
  for (const role of ["anon", "service_role"] as const) {
    await expect(as(role, finance, query, { sessionId: finance, method: "password" })).rejects.toMatchObject({ code: "42501" });
  }
  for (const id of [buyer, finance, warehouse, catalogue]) {
    await expect(as("authenticated", id, query, false)).rejects.toMatchObject({
      code: "42501", message: "staff_sales_role_required",
    });
  }
  expect((await as("authenticated", warehouse, query, true)).canSeeMargin).toBe(false);
  expect((await as("authenticated", catalogue, query, true)).canSeeMargin).toBe(false);
  await expect(as("authenticated", finance, query, { sessionId: finance, method: "otp" })).rejects.toMatchObject({ code: "42501" });

  const factor = randomUUID();
  await db.query(`
    insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
    values ($1, $2, 'totp', 'verified', now(), now()), ($3, $3, 'totp', 'verified', now(), now())
  `, [factor, finance, buyer]);
  await db.query(`
    insert into auth.sessions (id, user_id, factor_id, aal, created_at, updated_at)
    values ($1, $2, $1, 'aal2', now(), now()), ($3, $3, $3, 'aal2', now(), now())
  `, [factor, finance, buyer]);
  await expect(as("authenticated", finance, query, { sessionId: factor, method: "password" }))
    .rejects.toMatchObject({ code: "42501", message: "staff_sales_role_required" });
  await expect(as("authenticated", buyer, query, { sessionId: buyer, method: "password" }))
    .rejects.toMatchObject({ code: "42501", message: "staff_sales_role_required" });
});

test("validates inclusive report dates and grain at the RPC boundary", async () => {
  const id = await staff("warehouse");
  for (const range of [
    [null, "2025-04-01"], ["2025-04-01", null], ["-infinity", "2025-04-01"],
    ["2025-04-01", "infinity"], ["2025-04-01", "2025-03-31"], ["1899-12-31", "1900-01-01"],
    ["2024-01-01", "2025-01-01"], ["2999-01-01", "2999-01-01"],
  ]) {
    await expect(report(id, ...range)).rejects.toMatchObject({ code: "22023", message: "invalid_sales_range" });
  }
  for (const grain of [null, "year", "DAY"]) {
    await expect(report(id, "2025-03-29", "2025-03-29", grain))
      .rejects.toMatchObject({ code: "22023", message: "invalid_sales_grain" });
  }
  expect((await report(id, "2024-01-01", "2024-12-31")).daily).toHaveLength(366);
  const { available } = await createAccountCatalogue(db);
  const empty = await report(id, "1900-01-01", "1900-01-01");
  expect(empty.daily).toEqual([{
    date: "1900-01-01", revenuePence: 0, vatPence: 0, deliveryPence: 0, orders: 0, units: 0, refundsPence: 0, creditsPence: 0,
  }]);
  expect(empty.series).toEqual(empty.daily);
  expect(empty.current.aovPence).toBeNull();
  expect(empty.products.find((product) => product.id === available.id)?.shareBps).toBeNull();
});

test("reconciles booked goods, London DST buckets, payment adjustments, identities and current stock", async () => {
  const id = await staff("finance", "warehouse");
  const { available, selected, soldOut } = await createAccountCatalogue(db);
  const { available: never } = await createAccountCatalogue(db);
  const { id: accountBuyer } = await createAccountBuyer(db);
  const { id: tradeBuyer } = await createAccountBuyer(db);
  const guest = accountEmail();
  const account = await tradeAccount(tradeBuyer);

  const prior = await booking("2025-03-25T00:00:00Z", [line(soldOut)], { buyerId: accountBuyer });
  await cardRefund(prior, 100, "2025-03-28T23:59:59Z");
  await booking("2025-03-24T23:59:59Z", [line(available)], { email: guest });
  await booking("2025-03-28T12:00:00Z", [line(never)], { buyerId: tradeBuyer, state: "refunded" });
  await booking("2025-03-29T00:00:00Z", [line(available, 2), line(selected, 5, 900)], { buyerId: accountBuyer });
  await booking("2025-03-30T22:59:59Z", [line(available)], { email: guest.toUpperCase() });
  const net30 = await booking("2025-03-30T23:00:00Z", [line(selected, 10, 800)], { buyerId: tradeBuyer, email: guest });
  await booking("2025-04-01T22:59:59Z", [line(available, 1, 1010)], { email: guest });
  await booking("2025-04-01T23:00:00Z", [line(available)], { email: guest });
  const cancelled = await booking("2025-03-29T12:00:00Z", [line(never)]);
  await db.query("update public.orders set fulfilment_status = 'cancelled', dispatched_at = null where id = $1", [cancelled]);
  await cardRefund(cancelled, 500, "2025-03-30T22:59:59Z");

  const mismatch = await booking("2025-03-30T12:00:00Z", [line(never)], { state: "pending" });
  const mismatchedIntent = `pi_${mismatch.replaceAll("-", "")}`;
  await db.query(`
    update public.orders set payment_intent_id = $2, payment_review_reason = 'payment_amount_or_currency_mismatch' where id = $1
  `, [mismatch, mismatchedIntent]);
  await db.query("select public.resolve_refunded_payment_review($1, $2, $3, $4)", [
    mismatch, mismatchedIntent, `re_${mismatch.replaceAll("-", "")}`, id,
  ]);
  await db.query(`
    update private.order_operations set created_at = '2025-03-30T23:00:00Z'
    where order_id = $1 and action = 'resolve_refunded_payment_review'
  `, [mismatch]);

  const providerId = await invoice(net30, account);
  await db.query("select public.apply_invoice_payment($1, $2, 2000, 'GBP')", [providerId, randomUUID()]);
  await db.query("select public.apply_credit_note($1, $2, 700, 400, 'GBP')", [providerId, randomUUID()]);
  await db.query("select public.apply_invoice_refund($1, $2, 300, 'GBP')", [providerId, randomUUID()]);
  await db.query("update public.credit_ledger set created_at = '2025-03-30T23:00:00Z' where order_id = $1", [net30]);

  const voided = await booking("2025-03-30T23:30:00Z", [line(never, 1, 1300)], { buyerId: tradeBuyer });
  const voidId = await invoice(voided, account, false);
  await db.query("select public.void_invoice($1)", [voidId]);
  await db.query("update public.credit_ledger set created_at = '2025-04-01T22:59:59Z' where order_id = $1", [voided]);
  await db.query("select public.submit_trial_request($1, 'zund', '3910301', $2, 'Trade sample', 'SW1A 1AA')", [
    randomUUID(), accountEmail(),
  ]);
  await db.query(`
    insert into public.order_returns (id, order_id, variant_id, quantity, restored_quantity, reason, recorded_by)
    values (gen_random_uuid(), $1, $2, 1, 0, 'Fixture return', $3)
  `, [net30, selected.id, id]);
  await db.query("update public.variants set stock_reserved = 12 where id = $1", [available.id]);
  await db.query("update public.variants set publication_status = 'archived', stock_on_hand = 0 where id = $1", [selected.id]);

  await db.query("set local timezone to 'Pacific/Honolulu'");
  const sales = await report(id, "2025-03-29", "2025-04-01", "week");
  expect(sales.current).toEqual({
    revenuePence: 16510, vatPence: 3858, deliveryPence: 2780, orders: 4, units: 19, aovPence: 4128,
    marginPence: null, marginBps: null, refundsPence: 800, creditsPence: 2794,
  });
  expect(sales.previous).toEqual({
    revenuePence: 1000, vatPence: 339, deliveryPence: 695, orders: 1, units: 1, aovPence: 1000,
    marginPence: null, marginBps: null, refundsPence: 100, creditsPence: 0,
  });
  expect(sales.daily).toEqual([
    { date: "2025-03-29", revenuePence: 6500, vatPence: 1439, deliveryPence: 695, orders: 1, units: 7, refundsPence: 0, creditsPence: 0 },
    { date: "2025-03-30", revenuePence: 1000, vatPence: 339, deliveryPence: 695, orders: 1, units: 1, refundsPence: 500, creditsPence: 0 },
    { date: "2025-03-31", revenuePence: 8000, vatPence: 1739, deliveryPence: 695, orders: 1, units: 10, refundsPence: 300, creditsPence: 400 },
    { date: "2025-04-01", revenuePence: 1010, vatPence: 341, deliveryPence: 695, orders: 1, units: 1, refundsPence: 0, creditsPence: 2394 },
  ]);
  expect(sales.series).toEqual([
    { date: "2025-03-24", revenuePence: 7500, vatPence: 1778, deliveryPence: 1390, orders: 2, units: 8, refundsPence: 500, creditsPence: 0 },
    { date: "2025-03-31", revenuePence: 9010, vatPence: 2080, deliveryPence: 1390, orders: 2, units: 11, refundsPence: 300, creditsPence: 2794 },
  ]);
  const monthly = await report(id, "2025-03-29", "2025-04-01", "month");
  expect(monthly.daily).toEqual(sales.daily);
  expect(monthly.series).toEqual([
    { date: "2025-03-01", revenuePence: 15500, vatPence: 3517, deliveryPence: 2085, orders: 3, units: 18, refundsPence: 800, creditsPence: 400 },
    sales.daily[3],
  ]);
  expect(sales.payments).toEqual([
    { key: "card", revenuePence: 8510, units: 9, orders: 3 },
    { key: "net30", revenuePence: 8000, units: 10, orders: 1 },
  ]);
  expect(sales.tiers).toEqual([
    { key: "1-4", revenuePence: 4010, units: 4 },
    { key: "5-9", revenuePence: 4500, units: 5 },
    { key: "10+", revenuePence: 8000, units: 10 },
  ]);
  expect(sales.buyers).toEqual({ new: 1, returning: 2 });
  expect(sales.products.slice(0, 2)).toEqual([
    expect.objectContaining({ id: selected.id, published: false, revenuePence: 12500, units: 15, shareBps: 7571,
      available: 0, weeklyUnits: 26.25, weeksCover: 0, stockFlag: null }),
    expect.objectContaining({ id: available.id, published: true, revenuePence: 4010, units: 4, shareBps: 2429,
      available: 8, weeklyUnits: 7, weeksCover: 8 / 7, stockFlag: "low" }),
  ]);
  expect(sales.products.find((p) => p.id === soldOut.id)).toMatchObject({
    units: 0, weeksCover: null, stockFlag: "no_sales", costUnknown: false,
  });
  expect(sales.products.find((p) => p.id === never.id)).toMatchObject({
    units: 0, weeksCover: null, stockFlag: "never_sold", costUnknown: false,
  });
  expect(JSON.stringify(sales)).not.toMatch(/example[.]com|PO-42|Test Lane/);
});

test("uses the costed receipt at authorisation, including corrections, and isolates unknown costs", async () => {
  const id = await staff("warehouse", "finance");
  const catalogue = await staff("catalogue");
  const { available, selected } = await createAccountCatalogue(db);
  const receipt = await as("authenticated", id, async () => {
    await db.query("select public.set_staff_variant_cost($1, $2)", [available.id, cost(100)]);
    const receipt = (await db.query<{ id: string }>(
      "select public.receive_staff_stock_with_cost($1, $2, 10, $3) as id", [available.id, randomUUID(), cost(200)],
    )).rows[0]!.id;
    await db.query(`
      select public.correct_staff_receipt_cost($1, $2, recorded_at, $3)
      from public.staff_effective_receipt_costs where stock_movement_id = $2
    `, [available.id, receipt, cost(300)]);
    return receipt;
  }, true);
  await db.query("update public.stock_movements set created_at = '2025-10-26T00:30:00Z' where id = $1", [receipt]);
  const uncosted = `fixture-${randomUUID()}`;
  await db.query("select public.receive_stock($1, $2, 5, $3)", [available.id, uncosted, id]);
  await db.query("update public.stock_movements set created_at = '2025-10-26T00:35:00Z' where operation_key = 'receive:' || $1", [uncosted]);
  const later = await as("authenticated", id, async () => (await db.query<{ id: string }>(
    "select public.receive_staff_stock_with_cost($1, $2, 10, $3) as id", [available.id, randomUUID(), cost(600)],
  )).rows[0]!.id, true);
  await db.query("update public.stock_movements set created_at = '2025-10-26T01:45:00Z' where id = $1", [later]);

  await booking("2025-10-24T22:59:59Z", [line(available, 1, 700)]);
  await booking("2025-10-24T23:00:00Z", [line(available, 1, 900)]);
  await booking("2025-10-26T00:30:00Z", [line(available, 2, 900)]);
  await booking("2025-10-26T01:30:00Z", [line(available, 1, 900)]);
  await booking("2025-10-27T00:00:00Z", [line(selected)]);

  const priced = await report(id, "2025-10-25", "2025-10-26");
  expect(priced.daily.map(({ date, orders }) => ({ date, orders }))).toEqual([
    { date: "2025-10-25", orders: 1 }, { date: "2025-10-26", orders: 2 },
  ]);
  expect(priced.current).toMatchObject({ units: 4, revenuePence: 3600, marginPence: 2600, marginBps: 7222 });
  expect(priced.previous).toMatchObject({ units: 1, revenuePence: 700, marginPence: 600, marginBps: 8571 });
  expect(priced.products.find((p) => p.id === available.id)).toMatchObject({ costUnknown: false, marginPence: 2600 });
  const unknown = await report(id, "2025-10-25", "2025-10-27");
  expect(unknown.current).toMatchObject({ revenuePence: 4600, marginPence: null, marginBps: null });
  expect(unknown.products.find((p) => p.id === selected.id)).toMatchObject({ costUnknown: true, marginPence: null, marginBps: null });
  expect(unknown.products.find((p) => p.id === available.id)).toMatchObject({ costUnknown: false, marginPence: 2600 });
  const redacted = await report(catalogue, "2025-10-25", "2025-10-26");
  expect(redacted.current).toMatchObject({ units: 4, revenuePence: 3600, marginPence: null, marginBps: null });
  expect(redacted.previous).toMatchObject({ marginPence: null, marginBps: null });
  expect(redacted.products.find((p) => p.id === available.id)).toMatchObject({ costUnknown: null, marginPence: null, marginBps: null });
  expect(redacted.daily).toEqual(priced.daily);
});
