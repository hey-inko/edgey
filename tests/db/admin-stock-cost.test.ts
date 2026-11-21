import { randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { setDbClaims } from "../helpers/db-claims";

type StaffRole = "warehouse" | "catalogue" | "finance";
type Session = { id: string; steppedUp: boolean; sessionId?: string };

let db: Client;
let connectionString: string;

const cost = {
  supplier_unit_minor: 325, currency: "USD", landed_unit_pence: 315,
  exchange_rate: "0.785", freight_unit_pence: 27, duty_unit_pence: 8, note: "First batch",
};
const delivery = { recipient_name: "Test Buyer", line1: "1 Test Street", town: "London", postcode: "SW1A 1AA", country: "GB" };

async function connect() {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3000, statement_timeout: 8000 });
  await client.connect();
  return client;
}

beforeAll(async () => {
  const url = process.env.SUPABASE_DB_URL;
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
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

async function rpc<T = string>(name: string, args: unknown[], client = db) {
  return (await one<{ result: T }>(
    `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args, client,
  )).result;
}

async function user(...roles: StaffRole[]) {
  const id = randomUUID();
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@example.test`]);
  for (const role of roles) {
    await db.query("insert into public.staff_members (user_id, role) values ($1, $2)", [id, role]);
  }
  if (roles.length) await setDbClaims(db, "authenticated", id, true);
  return { id, steppedUp: roles.length > 0 };
}

async function asStaff<T>(session: Session | null, run: () => Promise<T>, client = db) {
  const role = session ? "authenticated" : "anon";
  const claims = {
    role, sub: session?.id, aal: session?.steppedUp ? "aal2" : "aal1",
    session_id: session?.sessionId ?? session?.id, amr: [{ method: "password" }],
  };
  await client.query("savepoint staff_session");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query(`set local role ${role}`);
    const result = await run();
    await client.query("reset role");
    return result;
  } catch (error) {
    await client.query("rollback to savepoint staff_session");
    throw error;
  } finally {
    await client.query("release savepoint staff_session");
  }
}

async function variant(warehouse: Session, count: number) {
  const sku = `stock-cost-${randomUUID()}`;
  const { id: family } = await one<{ id: string }>(`
    insert into public.products (family_code, slug, name, tool_category)
    values ($1, $1, 'Stock cost test family', 'oscillating') returning id
  `, [sku]);
  const { id } = await one<{ id: string }>(`
    insert into public.variants (product_id, sku, supplier_part_number, evidence_source, approved_at,
      publication_status, price_1_4_pence, price_5_9_pence, price_10_plus_pence)
    values ($1, $2, $2, 'DB fixture', now(), 'published', 1000, 900, 800) returning id
  `, [family, sku]);
  if (count) await rpc("receive_stock", [id, randomUUID(), count, warehouse.id]);
  return { id, family };
}

const stock = (id: string) => one("select stock_on_hand, stock_reserved from public.variants where id = $1", [id]);
const adjust = (id: string, key: string, quantity: number, reason: string, note?: string, client = db) =>
  rpc("adjust_staff_stock", note === undefined ? [id, key, quantity, reason] : [id, key, quantity, reason, note], client);
const setCost = (id: string, input: unknown = cost, client = db) =>
  rpc("set_staff_variant_cost", [id, JSON.stringify(input)], client);
const receive = (id: string, key: string, quantity: number, input: unknown = cost, client = db) =>
  rpc("receive_staff_stock_with_cost", [id, key, quantity, JSON.stringify(input)], client);
const currentCost = async (id: string) => (await db.query(
  "select * from public.staff_current_variant_costs where variant_id = $1", [id],
)).rows;

describe("staff stock and unit costs", () => {
  beforeEach(() => db.query("begin"));
  afterEach(() => db.query("rollback"));

  test("checks staff role and approved AAL2 session before each mutation and cost read", async () => {
    const warehouse = await user("warehouse");
    const catalogue = await user("catalogue");
    const finance = await user("finance");
    const both = await user("warehouse", "finance");
    const buyer = await user();
    const unapprovedSession = { ...both, sessionId: randomUUID() };
    const { id } = await variant(warehouse, 2);
    const denied = { code: "42501" };
    const runAdjust = () => adjust(id, randomUUID(), 1, "count_correction");
    const runReceive = () => receive(id, randomUUID(), 1);
    const runSetCost = () => setCost(id);
    const costRelations = ["staff_variant_costs", "staff_receipt_costs", "staff_variant_cost_audit", "staff_current_variant_costs"];
    const readCost = async (table: string) => (await db.query(
      `select variant_id from public.${table} where variant_id = $1`, [id],
    )).rows;

    await asStaff(catalogue, runSetCost);
    await asStaff(both, runReceive);
    for (const run of [runAdjust, runReceive, runSetCost]) {
      await expect(asStaff(null, run)).rejects.toMatchObject(denied);
      await expect(asStaff(buyer, run)).rejects.toMatchObject(denied);
      await expect(asStaff({ ...both, steppedUp: false }, run)).rejects.toMatchObject(denied);
      await expect(asStaff(unapprovedSession, run)).rejects.toMatchObject(denied);
    }
    for (const session of [catalogue, finance]) {
      await expect(asStaff(session, runAdjust)).rejects.toMatchObject(denied);
      await expect(asStaff(session, runReceive)).rejects.toMatchObject(denied);
    }
    await expect(asStaff(warehouse, runSetCost)).rejects.toMatchObject(denied);
    await expect(asStaff(warehouse, runReceive)).rejects.toMatchObject(denied);
    await expect(asStaff(warehouse, runAdjust)).resolves.toEqual(expect.any(String));
    await expect(asStaff(finance, runSetCost)).resolves.toBe(id);
    for (const table of costRelations) {
      await expect(asStaff(null, () => readCost(table))).rejects.toMatchObject(denied);
      for (const session of [buyer, warehouse, { ...both, steppedUp: false }, unapprovedSession]) {
        expect(await asStaff(session, () => readCost(table))).toEqual([]);
      }
      for (const session of [catalogue, finance, both]) {
        expect(await asStaff(session, () => readCost(table))).toEqual([{ variant_id: id }]);
      }
    }

    for (const table of costRelations.slice(0, 3)) {
      for (const mutation of [
        `insert into public.${table} (variant_id) values ($1)`,
        `update public.${table} set actor_id = $1 where variant_id = $1`,
        `delete from public.${table} where variant_id = $1`,
      ]) {
        await expect(asStaff(both, () => db.query(mutation, [id]))).rejects.toMatchObject(denied);
      }
    }
    await expect(asStaff(both, () => db.query(
      "update public.stock_movements set adjustment_note = 'changed' where variant_id = $1", [id],
    ))).rejects.toMatchObject(denied);
  });

  test("changes signed stock exactly once and records adjustment details without touching reserves", async () => {
    const warehouse = await user("warehouse");
    const another = await user("warehouse");
    const { id } = await variant(warehouse, 5);
    const { id: otherVariant } = await variant(warehouse, 5);
    const key = randomUUID();
    const movementId = await asStaff(warehouse, () => adjust(id, key, -3, "damaged", "  Chipped edges  "));
    expect(await asStaff(warehouse, () => adjust(id, key, -3, "damaged", "Chipped edges"))).toBe(movementId);
    const positive = await asStaff(warehouse, () => adjust(id, randomUUID(), 2, "count_correction"));
    for (const replay of [
      () => asStaff(warehouse, () => adjust(id, key, -2, "damaged", "Chipped edges")),
      () => asStaff(warehouse, () => adjust(id, key, -3, "lost", "Chipped edges")),
      () => asStaff(warehouse, () => adjust(id, key, -3, "damaged", "Different note")),
      () => asStaff(warehouse, () => adjust(otherVariant, key, -3, "damaged", "Chipped edges")),
      () => asStaff(another, () => adjust(id, key, -3, "damaged", "Chipped edges")),
    ]) {
      await expect(replay()).rejects.toMatchObject({ code: "22023", message: "operation_key_conflict" });
    }
    expect(await stock(id)).toEqual({ stock_on_hand: 4, stock_reserved: 0 });
    const { rows } = await db.query(`
      select id, actor_id, on_hand_delta, reserved_delta, adjustment_reason, adjustment_note,
        on_hand_before, on_hand_after, reserved_before, reserved_after, created_at
      from public.stock_movements where variant_id = $1 and kind = 'adjust' order by id
    `, [id]);
    expect(rows).toEqual([
      { id: movementId, actor_id: warehouse.id, on_hand_delta: -3, reserved_delta: 0, adjustment_reason: "damaged",
        adjustment_note: "Chipped edges", on_hand_before: 5, on_hand_after: 2, reserved_before: 0,
        reserved_after: 0, created_at: expect.any(Date) },
      { id: positive, actor_id: warehouse.id, on_hand_delta: 2, reserved_delta: 0, adjustment_reason: "count_correction",
        adjustment_note: null, on_hand_before: 2, on_hand_after: 4, reserved_before: 0,
        reserved_after: 0, created_at: expect.any(Date) },
    ]);
  });

  test("rejects invalid adjustments and costs without a partial movement or audit", async () => {
    const both = await user("warehouse", "catalogue");
    const { id } = await variant(both, 2);
    for (const [key, quantity, reason, note] of [
      ["  \t", 1, "count_correction"], [randomUUID(), 0, "lost"], [randomUUID(), -1, "incorrect"],
      [randomUUID(), 1, "damaged"], [randomUUID(), 1, "lost"], [randomUUID(), 1, "sample_given"],
      [randomUUID(), 1, "returned_to_supplier"],
      [randomUUID(), -1, "other"], [randomUUID(), -1, "other", " \n\t "],
      [randomUUID(), 1, "other", "x".repeat(501)], [randomUUID(), 2147483647, "count_correction"],
    ] as const) {
      await expect(asStaff(both, () => adjust(id, key, quantity, reason, note)))
        .rejects.toMatchObject({ code: "22023", message: "invalid_stock_adjustment" });
    }
    await expect(asStaff(both, () => adjust(id, randomUUID(), -3, "lost")))
      .rejects.toMatchObject({ code: "22023", message: "stock_adjustment_below_reserved" });

    for (const input of [
      null, [], "value", {}, { ...cost, supplier: "Unexpected field" }, { ...cost, currency: "JPY" },
      { ...cost, supplier_unit_minor: "325" }, { ...cost, supplier_unit_minor: 2147483648 },
      { ...cost, landed_unit_pence: -3 }, { ...cost, freight_unit_pence: 2.5 }, { ...cost, duty_unit_pence: -1 },
      { ...cost, exchange_rate: "NaN" }, { ...cost, exchange_rate: 1000001 }, { ...cost, exchange_rate: 0 },
      { ...cost, exchange_rate: 0.123456789 }, { ...cost, note: false }, { ...cost, note: "x".repeat(501) },
    ]) {
      await expect(asStaff(both, () => setCost(id, input)))
        .rejects.toMatchObject({ code: "22023", message: "invalid_staff_cost" });
      await expect(asStaff(both, () => receive(id, randomUUID(), 1, input)))
        .rejects.toMatchObject({ code: "22023", message: "invalid_staff_cost" });
    }
    await expect(asStaff(both, () => receive(id, randomUUID(), -1)))
      .rejects.toMatchObject({ code: "22023", message: "invalid_stock_receipt" });
    expect(await stock(id)).toEqual({ stock_on_hand: 2, stock_reserved: 0 });
    expect(await one("select count(*)::int as count from public.stock_movements where variant_id = $1", [id]))
      .toEqual({ count: 1 });
    expect(await currentCost(id)).toEqual([]);
    expect(await one("select count(*)::int as count from public.staff_variant_cost_audit where variant_id = $1", [id]))
      .toEqual({ count: 0 });
  });

  test("plain receipts snapshot stock and replay even when a second receipt would overflow", async () => {
    const warehouse = await user("warehouse");
    const { id } = await variant(warehouse, 0);
    const key = randomUUID();
    const plainReceipt = async () => one(`
      select id, on_hand_before, on_hand_after, reserved_before, reserved_after
      from public.receive_stock($1, $2, 2147483647, $3)
    `, [id, key, warehouse.id]);
    const first = await plainReceipt();
    expect(first).toEqual({
      id: expect.any(String), on_hand_before: 0, on_hand_after: 2147483647, reserved_before: 0, reserved_after: 0,
    });
    expect(await plainReceipt()).toEqual(first);
    expect(await stock(id)).toEqual({ stock_on_hand: 2147483647, stock_reserved: 0 });
  });

  test("keeps estimate history and picks the latest costed receipt over estimates and uncosted receipts", async () => {
    const catalogue = await user("catalogue");
    const both = await user("warehouse", "finance");
    const { id } = await variant(both, 2);
    const legacy = randomUUID();
    await rpc("receive_stock", [id, legacy, 2, both.id]);
    await expect(asStaff(both, () => receive(id, legacy, 2)))
      .rejects.toMatchObject({ code: "22023", message: "operation_key_conflict" });
    expect(await currentCost(id)).toEqual([]);
    expect(await asStaff(catalogue, () => setCost(id))).toBe(id);
    expect(await currentCost(id)).toEqual([{
      ...cost, variant_id: id, source: "estimate", stock_movement_id: null, received_quantity: null,
      actor_id: catalogue.id, recorded_at: expect.any(Date),
    }]);
    await asStaff(catalogue, () => setCost(id, { ...cost, exchange_rate: 0.785 }));

    const key = randomUUID();
    const first = await asStaff(both, () => receive(id, key, 3));
    await rpc("receive_stock", [id, key, 3, both.id]);
    expect(await asStaff(both, () => receive(id, key, 3, { ...cost, note: " First batch " }))).toBe(first);
    for (const attempt of [
      () => receive(id, key, 4), () => receive(id, key, 3, { ...cost, landed_unit_pence: 316 }),
    ]) {
      await expect(asStaff(both, attempt)).rejects.toMatchObject({ code: "22023", message: "operation_key_conflict" });
    }
    const updated = { currency: "EUR", supplier_unit_minor: 300, landed_unit_pence: 280 };
    const second = await asStaff(both, () => receive(id, randomUUID(), 4, updated));
    await rpc("receive_stock", [id, randomUUID(), 1, both.id]);
    const revised = { ...cost, landed_unit_pence: 999 };
    await asStaff(both, () => setCost(id, revised));
    expect(await stock(id)).toEqual({ stock_on_hand: 12, stock_reserved: 0 });
    expect(await currentCost(id)).toEqual([{
      ...updated, variant_id: id, source: "receipt", stock_movement_id: second, received_quantity: 4,
      exchange_rate: null, freight_unit_pence: null, duty_unit_pence: null, note: null,
      actor_id: both.id, recorded_at: expect.any(Date),
    }]);
    expect((await db.query(`
      select r.stock_movement_id, r.received_quantity, r.landed_unit_pence, r.actor_id,
        m.kind, m.on_hand_before, m.on_hand_after, m.reserved_before, m.reserved_after
      from public.staff_receipt_costs r join public.stock_movements m on m.id = r.stock_movement_id
      where r.variant_id = $1 order by r.stock_movement_id
    `, [id])).rows).toEqual([
      { stock_movement_id: first, received_quantity: 3, landed_unit_pence: 315, actor_id: both.id, kind: "receive",
        on_hand_before: 4, on_hand_after: 7, reserved_before: 0, reserved_after: 0 },
      { stock_movement_id: second, received_quantity: 4, landed_unit_pence: 280, actor_id: both.id, kind: "receive",
        on_hand_before: 7, on_hand_after: 11, reserved_before: 0, reserved_after: 0 },
    ]);
    const auditCost = { ...cost, exchange_rate: 0.785 };
    expect((await db.query(`
      select old_cost, new_cost, actor_id, recorded_at from public.staff_variant_cost_audit
      where variant_id = $1 order by id
    `, [id])).rows).toEqual([
      { old_cost: null, new_cost: auditCost, actor_id: catalogue.id, recorded_at: expect.any(Date) },
      { old_cost: auditCost, new_cost: { ...auditCost, landed_unit_pence: 999 }, actor_id: both.id, recorded_at: expect.any(Date) },
    ]);
  });
});

describe("staff stock transactions under concurrent demand", () => {
  let warehouse: Session;
  let item: Awaited<ReturnType<typeof variant>>;
  let worker: Client;
  let orderToken: string;
  let trialId: string;

  beforeEach(async () => {
    warehouse = await user("warehouse", "catalogue");
    item = await variant(warehouse, 2);
    worker = await connect();
    orderToken = randomUUID();
    trialId = randomUUID();
  });

  afterEach(async () => {
    await worker?.end();
    await db.query("rollback");
    await db.query("begin");
    try {
      for (const table of ["staff_variant_cost_audit", "staff_variant_costs", "staff_receipt_costs", "stock_movements"]) {
        await db.query(`delete from public.${table} where variant_id = $1`, [item.id]);
      }
      for (const table of ["stock_reservations", "order_items"]) {
        await db.query(`
          delete from public.${table} where order_id in (select id from public.orders where checkout_attempt_token = $1)
        `, [orderToken]);
      }
      await db.query("delete from public.orders where checkout_attempt_token = $1", [orderToken]);
      await db.query("delete from public.trial_allocations where trial_request_id = $1", [trialId]);
      await db.query("delete from public.trial_fulfilments where trial_request_id = $1", [trialId]);
      await db.query("delete from public.trial_requests where id = $1", [trialId]);
      await db.query("delete from public.variants where id = $1", [item.id]);
      await db.query("delete from public.products where id = $1", [item.family]);
      await db.query("delete from auth.users where id = $1", [warehouse.id]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });

  async function race<T>(first: () => Promise<unknown>, second: () => Promise<T>) {
    const { pid } = await one<{ pid: number }>("select pg_backend_pid() as pid", [], worker);
    await db.query("begin");
    let pending: Promise<PromiseSettledResult<T>[]> | undefined;
    try {
      await first();
      pending = Promise.allSettled([second()]);
      await expect.poll(async () => (await one<{ waiting: boolean }>(
        "select pg_backend_pid() = any(pg_blocking_pids($1)) as waiting", [pid],
      )).waiting, { timeout: 4000 }).toBe(true);
      await db.query("commit");
      return (await pending)[0]!;
    } finally {
      await db.query("rollback");
      await pending;
    }
  }

  test("an adjustment blocked behind checkout respects its newly reserved stock", async () => {
    const key = randomUUID();
    const held = await race(() => db.query(`
      select id from public.create_order_with_reservations(
        $1, $2, $3, $4, $5, clock_timestamp() + interval '30 minutes', 'Standard',
        current_date + 1, current_date + 2, null
      )
    `, [
      orderToken, JSON.stringify([{ variant_id: item.id, quantity: 2, unit_price_pence: 1000 }]),
      JSON.stringify({ email: `${orderToken}@example.test`, business_name: "Test Fabrication",
        recipient_name: "Test Buyer", buying_for_work: true }),
      JSON.stringify(delivery),
      JSON.stringify({ goods_net_pence: 2000, delivery_net_pence: 0, vat_rate_bps: 2000, vat_pence: 400, gross_pence: 2400 }),
    ]), async () => {
      await worker.query("begin");
      return asStaff(warehouse, () => adjust(item.id, key, -1, "lost", "", worker), worker);
    });
    expect(held).toMatchObject({ status: "rejected", reason: { code: "22023", message: "stock_adjustment_below_reserved" } });
    expect(await stock(item.id)).toEqual({ stock_on_hand: 2, stock_reserved: 2 });
    expect(await one("select quantity, state from public.stock_reservations where variant_id = $1", [item.id]))
      .toEqual({ quantity: 2, state: "held" });
    expect((await db.query(`
      select kind, on_hand_before, on_hand_after, reserved_before, reserved_after
      from public.stock_movements where variant_id = $1 order by id
    `, [item.id])).rows).toEqual([
      { kind: "receive", on_hand_before: 0, on_hand_after: 2, reserved_before: 0, reserved_after: 0 },
      { kind: "reserve", on_hand_before: 2, on_hand_after: 2, reserved_before: 0, reserved_after: 2 },
    ]);
  });

  test("trial approval rechecks stock after an in-flight adjustment and does not partially allocate", async () => {
    await rpc("submit_trial_request", [trialId, "zund", "unknown", `${trialId}@example.test`, "Test Fabrication", delivery.postcode]);
    const { version } = await one<{ version: string }>(
      "select updated_at::text as version from public.trial_requests where id = $1", [trialId],
    );
    await rpc("review_admin_trial", [trialId, warehouse.id, "eligible", "Test fit", [item.id, item.id], version]);
    const approve = (client = db) => rpc("approve_trial_fulfilment", [
      trialId, warehouse.id, [item.id, item.id], JSON.stringify(delivery), "Test Carrier", "Standard", true,
    ], client);
    const trial = await race(
      () => asStaff(warehouse, () => adjust(item.id, randomUUID(), -1, "sample_given")),
      () => approve(worker),
    );
    expect(trial).toMatchObject({ status: "rejected", reason: { code: "P0001", message: "insufficient_stock" } });
    expect(await stock(item.id)).toEqual({ stock_on_hand: 1, stock_reserved: 0 });
    expect((await db.query("select state from public.trial_fulfilments where trial_request_id = $1", [trialId])).rows)
      .toEqual([]);
    await db.query("begin");
    try {
      await asStaff(warehouse, () => adjust(item.id, randomUUID(), 1, "count_correction"));
      await approve();
      await expect(asStaff(warehouse, () => adjust(item.id, randomUUID(), -1, "damaged")))
        .rejects.toMatchObject({ code: "22023", message: "stock_adjustment_below_reserved" });
      await db.query("commit");
    } finally {
      await db.query("rollback");
    }
    expect(await stock(item.id)).toEqual({ stock_on_hand: 2, stock_reserved: 2 });
    expect(await one("select quantity from public.trial_allocations where trial_request_id = $1", [trialId]))
      .toEqual({ quantity: 2 });
    expect(await one(`
      select on_hand_before, on_hand_after, reserved_before, reserved_after
      from public.stock_movements where trial_request_id = $1 and kind = 'reserve'
    `, [trialId])).toEqual({ on_hand_before: 2, on_hand_after: 2, reserved_before: 0, reserved_after: 2 });
  });

  test("two overlapping costed receipts for one key write one movement and one cost", async () => {
    const key = randomUUID();
    const write = (client: Client) => asStaff(warehouse, () => receive(item.id, key, 3, cost, client), client);
    let first: string | undefined;
    await worker.query("begin");
    const second = await race(async () => { first = await write(db); }, () => write(worker));
    expect(first).toEqual(expect.any(String));
    expect(second).toEqual({ status: "fulfilled", value: first });
    await worker.query("commit");
    expect(await stock(item.id)).toEqual({ stock_on_hand: 5, stock_reserved: 0 });
    expect(await currentCost(item.id)).toEqual([expect.objectContaining({ stock_movement_id: first })]);
    expect(await one("select count(*)::int as count from public.staff_receipt_costs where variant_id = $1", [item.id]))
      .toEqual({ count: 1 });
  });
});
