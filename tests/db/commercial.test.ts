import { randomUUID } from "node:crypto";
import type { Client, QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import type { CommercialMeasures } from "../../src/lib/commercial/database";
import { connectAccountDb, createAccountBuyer, createAccountCatalogue, createAccountOrder } from "../helpers/account-fixture";

let db: Client;

beforeAll(async () => { db = await connectAccountDb(); });
afterAll(() => db?.end());
beforeEach(() => db.query("begin isolation level repeatable read"));
afterEach(() => db.query("rollback"));

async function actor(role?: "warehouse" | "catalogue" | "finance") {
  const { id } = await createAccountBuyer(db);
  if (role) await db.query("insert into public.staff_members (user_id, role) values ($1, $2)", [id, role]);
  return id;
}

async function as<T extends QueryResultRow>(
  role: "anon" | "service_role" | "authenticated", user: string | null, sql: string, args: unknown[] = [],
) {
  await db.query("savepoint commercial_test");
  try {
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, aal: "aal2", role })]);
    return (await db.query<T>(sql, args)).rows;
  } catch (error) {
    await db.query("rollback to savepoint commercial_test");
    throw error;
  } finally {
    await db.query("reset role");
    await db.query("release savepoint commercial_test");
  }
}

const measures = async (warehouse: string) =>
  (await as<{ report: CommercialMeasures }>("authenticated", warehouse, "select public.admin_commercial_measures() report"))[0]!.report;

test("links only a current, catalogue-backed exact search to one owned checkout and matching lines", async () => {
  const warehouse = await actor("warehouse");
  const buyer = await actor();
  const otherBuyer = await actor();
  const { available, selected } = await createAccountCatalogue(db);
  const before = await measures(warehouse);
  const record = async (code: string, variants: string[]) =>
    (await as<{ id: string | null }>("service_role", null, "select public.record_exact_finder_search($1, $2) id", [code, variants]))[0]!.id;
  const code = available.sku.replaceAll("-", "");
  const eventId = await record(code, [available.id, selected.id]);
  const staleId = await record(code, [available.id]);
  expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await record("FORGEDCATALOGUECODE", [available.id])).toBeNull();
  await db.query("update public.finder_search_events set created_at = now() - interval '31 minutes' where id = $1", [staleId]);
  expect((await db.query("select variant_id from private.finder_exact_matches where event_id = $1", [eventId])).rows)
    .toEqual([{ variant_id: available.id }]);
  expect((await db.query("select normalised_query from public.finder_search_events where normalised_query = 'FORGEDCATALOGUECODE'")).rowCount).toBe(0);
  const line = (item: typeof available) => ({ ...item, quantity: 2, price: 2350 });
  async function order(...lines: (typeof available)[]) {
    const { id } = await createAccountOrder(db, {
      buyerId: buyer, email: `${buyer}@example.test`, state: "pending",
      createdAt: (await db.query<{ now: Date }>("select clock_timestamp() + interval '1 second' as now")).rows[0]!.now.toISOString(),
      lines: lines.map(line),
    });
    const [{ token }] = (await db.query<{ token: string }>("select checkout_attempt_token token from public.orders where id = $1", [id])).rows as [{ token: string }];
    return { id, token };
  }
  const unrelated = await order(selected);
  const mixed = await order(available, selected);
  const later = await order(available);
  const linkSql = "select public.link_finder_checkout($1, $2, $3, $4) as linked";
  const link = async (event: string | null, id: string, token: string, subject: string | null = buyer) =>
    (await as<{ linked: boolean }>("service_role", null, linkSql, [event, id, token, subject]))[0]!.linked;
  await expect(as("authenticated", buyer, linkSql, [eventId, mixed.id, mixed.token, buyer])).rejects.toMatchObject({ code: "42501" });
  expect(await link(eventId, mixed.id, mixed.token, otherBuyer)).toBe(false);
  expect(await link(eventId, mixed.id, mixed.token, null)).toBe(false);
  expect(await link(eventId, mixed.id, randomUUID())).toBe(false);
  expect(await link(eventId, unrelated.id, unrelated.token)).toBe(false);
  expect(await link(staleId, mixed.id, mixed.token)).toBe(false);
  expect(await link(eventId, mixed.id, mixed.token)).toBe(true);
  expect(await link(eventId, later.id, later.token)).toBe(false);
  expect((await measures(warehouse)).finder).toMatchObject({
    exact: before.finder.exact + 3, linkedWithoutAuthorisation: before.finder.linkedWithoutAuthorisation + 1,
    noLink: before.finder.noLink + 2, converted: before.finder.converted,
  });

  await db.query(`update public.orders set fulfilment_status = 'dispatched', payment_status = 'paid',
    authorised_at = created_at, dispatched_at = '2026-07-07 23:30Z', promised_dispatch_date = '2026-07-07',
    estimated_delivery_date = '2026-07-09', carrier = 'Fixture', tracking_number = 'Fixture' where id = $1`, [mixed.id]);
  await db.query(`update public.orders set fulfilment_status = 'dispatched', payment_status = 'paid',
    authorised_at = created_at, dispatched_at = '2026-07-07 22:30Z', promised_dispatch_date = '2026-07-07',
    estimated_delivery_date = '2026-07-09', carrier = 'Fixture', tracking_number = 'Fixture' where id = $1`, [later.id]);
  await expect(as("authenticated", buyer, "select public.admin_commercial_measures()")).rejects.toMatchObject({ code: "42501" });

  const recordReturn = (returnId: string, item: string, category = "wrong_fit", user = warehouse) =>
    as<{ lookup_code: string | null; reason_category: string }>("authenticated", user,
      "select lookup_code, reason_category from public.record_structured_return($1, $2, $3, 1, $4, 'Staff details stay out of analytics')",
      [mixed.id, returnId, item, category]);
  const returnId = randomUUID();
  await expect(recordReturn(returnId, available.id, "wrong_fit", buyer)).rejects.toMatchObject({ code: "42501" });
  expect(await recordReturn(returnId, available.id)).toEqual([{ lookup_code: code, reason_category: "wrong_fit" }]);
  expect(await recordReturn(randomUUID(), selected.id)).toEqual([{ lookup_code: null, reason_category: "wrong_fit" }]);
  expect(await recordReturn(returnId, available.id)).toEqual([{ lookup_code: code, reason_category: "wrong_fit" }]);
  await expect(recordReturn(returnId, available.id, "damaged")).rejects.toMatchObject({ message: "operation_key_conflict" });
  await expect(recordReturn(randomUUID(), available.id, "unknown")).rejects.toMatchObject({ message: "invalid_return_reason" });

  const after = await measures(warehouse);
  expect(after.dispatch).toEqual({
    total: before.dispatch.total + 2, withPromise: before.dispatch.withPromise + 2, onTime: before.dispatch.onTime + 1,
  });
  expect(after.finder.converted).toBe(before.finder.converted + 1);
  expect(after.wrongFit).toEqual(expect.arrayContaining([
    { sku: available.sku, code, units: 1, records: 1 },
    { sku: selected.sku, code: null, units: 1, records: 1 },
  ]));
  expect(JSON.stringify(after)).not.toMatch(/Staff details|example[.]test|Fixture/);
  await db.query("delete from public.finder_search_events where id = $1", [eventId]);
  expect(await recordReturn(returnId, available.id)).toEqual([{ lookup_code: code, reason_category: "wrong_fit" }]);
  expect((await measures(warehouse)).finder.converted).toBe(before.finder.converted);
});

test("trial mail status returns metadata only and validates request staff", async () => {
  const warehouse = await actor("warehouse");
  const catalogue = await actor("catalogue");
  const finance = await actor("finance");
  const id = randomUUID();
  const other = randomUUID();
  const submit = (id: string) => db.query("select public.submit_trial_request($1, 'zund', '3910301', $2, 'Fixture', 'SW1A 1AA')",
    [id, `${id}@example.test`]);
  await submit(id);
  await submit(other);
  const query = "select * from public.admin_trial_mail_status($1) order by message_key";
  const expected = [
    { message_key: "confirmation", status: "queued", sent_at: null },
    { message_key: "staff_notification", status: "queued", sent_at: null },
  ];
  expect(await as("authenticated", catalogue, query, [id])).toEqual(expected);
  expect(await as("authenticated", warehouse, query, [id])).toEqual(expected);
  await expect(as("authenticated", finance, query, [id])).rejects.toMatchObject({ code: "42501" });
  await expect(as("anon", null, query, [id])).rejects.toMatchObject({ code: "42501" });
  await db.query(`update public.order_outbox set state = 'failed', last_error = 'delivery_unconfirmed', delivery_uncertain = true
    where trial_request_id = $1 and message_key = 'confirmation'`, [id]);
  expect(await as("authenticated", warehouse, query, [id])).toEqual([{ ...expected[0], status: "unconfirmed" }, expected[1]]);
  expect(await as("authenticated", warehouse, query, [other])).toEqual(expected);
});

test("a cancelled never-authorised attempt can be replaced once by a later matching order", async () => {
  const warehouse = await actor("warehouse");
  const buyer = await actor();
  const other = await actor();
  const { available, selected } = await createAccountCatalogue(db);
  const code = available.sku.replaceAll("-", "");
  const [{ id: eventId }] = await as<{ id: string }>("service_role", null,
    "select public.record_exact_finder_search($1, $2) id", [code, [available.id]]) as [{ id: string }];
  const now = (await db.query<{ instant: Date }>("select clock_timestamp() instant")).rows[0]!.instant.getTime();
  async function attempt(position: number, buyerId = buyer, item = available) {
    const { id } = await createAccountOrder(db, {
      buyerId, email: `${buyerId}@example.test`, state: "pending",
      createdAt: new Date(now + position * 1000).toISOString(),
      lines: [{ ...item, quantity: 1, price: 2350 }],
    });
    const { token } = (await db.query<{ token: string }>("select checkout_attempt_token token from public.orders where id = $1", [id])).rows[0]!;
    return { id, token, buyerId };
  }
  const original = await attempt(1);
  const unrelated = await attempt(2, buyer, selected);
  const differentBuyer = await attempt(3, other);
  const replacement = await attempt(4);
  const later = await attempt(5);
  const link = async (order: typeof original) => (await as<{ linked: boolean }>("service_role", null,
    "select public.link_finder_checkout($1, $2, $3, $4) as linked", [eventId, order.id, order.token, order.buyerId]))[0]!.linked;
  const before = (await measures(warehouse)).finder;
  expect(await link(original)).toBe(true);
  expect(await link(replacement)).toBe(false);
  await db.query("update public.orders set fulfilment_status = 'cancelled' where id = $1", [original.id]);
  expect(await link(unrelated)).toBe(false);
  expect(await link(differentBuyer)).toBe(false);
  expect(await link(replacement)).toBe(true);
  expect(await link(replacement)).toBe(false);
  expect((await measures(warehouse)).finder).toMatchObject({
    exact: before.exact, linkedWithoutAuthorisation: before.linkedWithoutAuthorisation + 1, converted: before.converted,
  });
  await db.query("update public.orders set fulfilment_status = 'cancelled', authorised_at = created_at where id = $1", [replacement.id]);
  expect(await link(later)).toBe(false);
  expect((await db.query("select order_id from private.finder_order_attributions where event_id = $1", [eventId])).rows)
    .toEqual([{ order_id: replacement.id }]);
  expect((await measures(warehouse)).finder).toMatchObject({
    exact: before.exact, linkedWithoutAuthorisation: before.linkedWithoutAuthorisation, converted: before.converted + 1,
  });
});

test("a reported wrong-fit code is retained for staff but only a public catalogue code is grouped in measures", async () => {
  const warehouse = await actor("warehouse");
  const { available, selected } = await createAccountCatalogue(db);
  const { id } = await createAccountOrder(db, {
    buyerId: null, email: "fixture@example.test", state: "dispatched", createdAt: "2026-11-18T10:00:00Z",
    lines: [available, selected].map((item) => ({ ...item, quantity: 3, price: 2350 })),
  });
  const submit = (returnId: string, item: string, code: string, category = "wrong_fit") =>
    as("authenticated", warehouse, `select lookup_code, reported_lookup_code, reported_public_lookup_code
      from public.record_structured_return($1, $2, $3, 1, $4, 'Fixture note', $5)`, [id, returnId, item, category, code]);
  const returnId = randomUUID();
  const known = [{ lookup_code: null, reported_lookup_code: selected.sku, reported_public_lookup_code: selected.sku.replaceAll("-", "") }];
  expect(await submit(returnId, available.id, selected.sku)).toEqual(known);
  expect(await submit(returnId, available.id, selected.sku)).toEqual(known);
  await expect(submit(returnId, available.id, available.sku)).rejects.toMatchObject({ message: "operation_key_conflict" });
  expect(await submit(randomUUID(), selected.id, "Other-329"))
    .toEqual([{ lookup_code: null, reported_lookup_code: "Other-329", reported_public_lookup_code: null }]);
  for (const text of ["buyer@example.test", "198.51.100.24", "07700 900000", "SW1A 1AA", "a person's name"]) {
    await expect(submit(randomUUID(), available.id, text)).rejects.toMatchObject({ code: "23514" });
  }
  await expect(submit(randomUUID(), available.id, selected.sku, "damaged")).rejects.toMatchObject({ code: "23514" });
  const { wrongFit } = await measures(warehouse);
  expect(wrongFit).toEqual(expect.arrayContaining([
    { sku: available.sku, code: selected.sku.replaceAll("-", ""), records: 1, units: 1 },
    { sku: selected.sku, code: null, records: 1, units: 1 },
  ]));
  expect(JSON.stringify(wrongFit)).not.toContain("Other-329");
});

test("catalogue staff can add only a distinct unapproved, unstocked draft to an existing family", async () => {
  const catalogue = await actor("catalogue");
  const warehouse = await actor("warehouse");
  const { productId, available } = await createAccountCatalogue(db);
  const sku = `EDG-TEST-${randomUUID().slice(0, 8).toUpperCase()}`;
  const query = "select public.admin_create_draft_variant($1, $2, $3, $4, $5, $6) as id";
  const args = [productId, sku, "25°", 1200, 1000, 900];
  await expect(as("authenticated", warehouse, query, args)).rejects.toMatchObject({ code: "42501" });
  await expect(as("authenticated", catalogue, query, [productId, sku, null, 1200, 1300, 900])).rejects.toMatchObject({ code: "22023" });
  const [{ id }] = await as<{ id: string }>("authenticated", catalogue, query, args) as [{ id: string }];
  await expect(as("authenticated", catalogue, query, args)).rejects.toMatchObject({ code: "23505" });
  expect((await db.query(`select product_id, publication_status, stock_on_hand, stock_reserved, approved_at,
    (select count(*)::int from public.compatibility where variant_id = v.id) mappings
    from public.variants v where id = $1`, [id])).rows).toEqual([
    { product_id: productId, publication_status: "draft", stock_on_hand: 0, stock_reserved: 0, approved_at: null, mappings: 0 },
  ]);
  expect(await as("anon", null, "select sku from public.variants where sku in ($1, $2)", [sku, available.sku]))
    .toEqual([{ sku: available.sku }]);
});
