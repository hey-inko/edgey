import { randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

type Order = {
  id: string;
  gross_pence: number;
  hold_expires_at: Date;
  dispatched_at: Date | null;
};
type Variant = { id: string; sku: string; option_label: string };
type Line = { variant_id: string; quantity: number; unit_price_pence: number };

let connectionString: string;
let db: Client;

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

async function one<Row extends QueryResultRow>(client: Client, sql: string, values: unknown[] = []) {
  const { rows } = await client.query<Row>(sql, values);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const rpc = <Row extends QueryResultRow = Order>(name: string, values: unknown[], client = db) =>
  one<Row>(client, `select * from public.${name}(${values.map((_, i) => `$${i + 1}`).join(", ")})`, values);

const key = (prefix: string) => `${prefix}-${randomUUID()}`;

async function product() {
  const { id } = await one<{ id: string }>(db, `
    insert into public.products (family_code, slug, name, tool_category)
    values ($1, $1, 'Order test family', 'oscillating') returning id
  `, [key("order-test")]);
  return id;
}

function variant(productId: string, stock: number, optionLabel = "45°", id = randomUUID()) {
  const sku = key("ORDER-TEST");
  return one<Variant>(db, `
    insert into public.variants (
      id, product_id, sku, option_label, supplier_part_number, evidence_source, approved_at, publication_status,
      price_1_4_pence, price_5_9_pence, price_10_plus_pence, stock_on_hand
    ) values ($1, $2, $3, $4, $3, 'DB test fixture', now(), 'published', 1000, 900, 800, $5)
    returning id, sku, option_label
  `, [id, productId, sku, optionLabel, stock]);
}

async function user(role?: "warehouse" | "finance" | "catalogue") {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  if (role) await db.query("insert into public.staff_members (user_id, role) values ($1, $2)", [id, role]);
  return { id, email };
}

const line = (item: Variant, quantity = 1, unitPrice = 1000): Line => ({
  variant_id: item.id,
  quantity,
  unit_price_pence: unitPrice,
});

function createOrder(
  lines: Line[],
  { token = randomUUID(), buyer = null as string | null, email = "guest@example.test" } = {},
  client = db,
) {
  const delivery = 695;
  const net = lines.reduce((sum, item) => sum + item.quantity * item.unit_price_pence, 0);
  const tax = Math.round(delivery / 5) +
    lines.reduce((sum, item) => sum + Math.round(item.quantity * item.unit_price_pence / 5), 0);
  return rpc("create_order_with_reservations", [
    token,
    JSON.stringify(lines),
    JSON.stringify({ email, business_name: "Test Fabrication", recipient_name: "Test Buyer", buying_for_work: true }),
    JSON.stringify({ line1: "1 Test Street", town: "London", postcode: "sw1a1aa", country: "GB" }),
    JSON.stringify({
      goods_net_pence: net,
      delivery_net_pence: delivery,
      vat_rate_bps: 2000,
      vat_pence: tax,
      gross_pence: net + delivery + tax,
    }),
    new Date(Date.now() + 30 * 60 * 1000),
    "Standard",
    "2099-01-05",
    "2099-01-06",
    buyer,
  ], client);
}

const bind = (order: Order, session: string, client = db) =>
  rpc("bind_checkout_session", [order.id, session, order.hold_expires_at], client);

const pay = (order: Order, session: string, intent: string, invoice: string | null = null) =>
  rpc("confirm_payment", [order.id, session, intent, order.gross_pence, "GBP", invoice]);

const stock = (item: Variant) => one(db, `
  select stock_on_hand, stock_reserved, availability from public.variants where id = $1
`, [item.id]);

const quantity = (onHand: number, reserved: number) => ({
  stock_on_hand: onHand,
  stock_reserved: reserved,
  availability: onHand > reserved ? "in_stock" : "out_of_stock",
});

const reservations = async (order: Order) => (await db.query(`
  select variant_id, quantity, state from public.stock_reservations where order_id = $1 order by variant_id
`, [order.id])).rows;

const movements = async (item: Variant) => (await db.query(`
  select kind, order_id, variant_id, on_hand_delta, reserved_delta, operation_key
  from public.stock_movements where variant_id = $1 order by id
`, [item.id])).rows;

const movement = (item: Variant, kind: string, order: Order | null, onHand: number, reserved: number) =>
  expect.objectContaining({
    kind,
    order_id: order?.id ?? null,
    variant_id: item.id,
    on_hand_delta: onHand,
    reserved_delta: reserved,
    operation_key: expect.any(String),
  });

const outbox = async (order: Order) => (await db.query(`
  select order_id, message_key, state from public.order_outbox where order_id = $1
`, [order.id])).rows;

const confirmation = (order: Order) => ({
  order_id: order.id, message_key: "order_confirmation", state: "pending",
});

async function rejects(query: () => Promise<unknown>, message: string, code = "22023") {
  await db.query("savepoint expected_error");
  try {
    await expect(query()).rejects.toMatchObject({ code, message });
  } finally {
    await db.query("rollback to savepoint expected_error");
    await db.query("release savepoint expected_error");
  }
}

async function asRole<T>(role: "anon" | "authenticated" | "service_role", id: string | null, run: () => Promise<T>) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, sub: id })]);
  await db.query(`set local role ${role}`);
  const result = await run();
  await db.query("reset role");
  return result;
}

describe("order transactions", () => {
  beforeEach(() => db.query("begin"));
  afterEach(() => db.query("rollback"));

  test("snapshots the exact variant and exhausts its public availability without affecting its sibling", async () => {
    const family = await product();
    const selected = await variant(family, 5);
    const sibling = await variant(family, 2, "60°");
    const token = randomUUID();
    const lines = [line(selected, 5, 900)];
    const order = await asRole("service_role", null, () => createOrder(lines, { token }));
    expect(await createOrder(lines, { token })).toMatchObject({ id: order.id });
    expect(order).toMatchObject({
      buyer_id: null, fulfilment_status: "awaiting_authorisation", payment_status: "pending",
      address_postcode: "SW1A 1AA", delivery_service: "Standard",
      goods_net_pence: 4500, delivery_net_pence: 695, vat_pence: 1039, gross_pence: 6234,
    });
    expect(await one(db, `
      select promised_dispatch_date::text, estimated_delivery_date::text from public.orders where id = $1
    `, [order.id])).toEqual({ promised_dispatch_date: "2099-01-05", estimated_delivery_date: "2099-01-06" });
    await db.query("update public.variants set sku = $2, option_label = '50°' where id = $1", [selected.id, key("EDIT")]);
    expect(await one(db, "select * from public.order_items where order_id = $1", [order.id])).toEqual({
      order_id: order.id, variant_id: selected.id, sku: selected.sku, option_label: "45°",
      quantity: 5, unit_price_pence: 900, net_pence: 4500, tax_pence: 900, gross_pence: 5400,
    });
    const availability = await asRole("anon", null, async () => (await db.query(
      "select id, availability from public.variants where id = any($1::uuid[])",
      [[selected.id, sibling.id]],
    )).rows);
    expect(availability).toHaveLength(2);
    expect(availability).toEqual(expect.arrayContaining([
      { id: selected.id, availability: "out_of_stock" },
      { id: sibling.id, availability: "in_stock" },
    ]));
    expect(await reservations(order)).toEqual([{ variant_id: selected.id, quantity: 5, state: "held" }]);
    expect(await movements(selected)).toEqual([movement(selected, "reserve", order, 0, 5)]);
    expect(await stock(sibling)).toEqual(quantity(2, 0));
  });

  test("rolls back an earlier available line when a later one cannot be reserved and rejects normalized duplicates", async () => {
    const family = await product();
    const [firstId, lastId] = [randomUUID(), randomUUID()].sort();
    const available = await variant(family, 3, "45°", firstId);
    const soldOut = await variant(family, 0, "60°", lastId);
    const token = randomUUID();
    await rejects(() => createOrder([line(available), line(soldOut)], { token }), "insufficient_stock", "P0001");
    await rejects(() => createOrder([line(available), {
      ...line(available), variant_id: available.id.replaceAll("-", "").toUpperCase(),
    }], { token }), "duplicate_variant");
    await rejects(() => createOrder([line(available, 1, 999)], { token }), "stale_unit_price");
    await rejects(() => createOrder([line(available, 1.5)], { token }), "invalid_order_lines");
    await rejects(() => createOrder([line(available, 0)], { token }), "invalid_order_lines");
    expect(await db.query("select id from public.orders where checkout_attempt_token = $1", [token]))
      .toMatchObject({ rowCount: 0 });
    expect(await db.query("select order_id from public.order_items where variant_id = any($1::uuid[])", [
      [available.id, soldOut.id],
    ])).toMatchObject({ rowCount: 0 });
    expect(await movements(available)).toEqual([]);
    expect(await stock(available)).toEqual(quantity(3, 0));
    expect(await stock(soldOut)).toEqual(quantity(0, 0));
  });

  test("checks all-units tier boundaries against current catalogue prices", async () => {
    const item = await variant(await product(), 30);
    for (const [count, expectedPrice, wrongPrice] of [
      [1, 1000, 900], [4, 1000, 900], [5, 900, 1000], [9, 900, 800], [10, 800, 900],
    ] as const) {
      await rejects(() => createOrder([line(item, count, wrongPrice)]), "stale_unit_price");
      const order = await createOrder([line(item, count, expectedPrice)]);
      expect(await one(db, "select quantity, unit_price_pence, net_pence from public.order_items where order_id = $1", [order.id]))
        .toEqual({ quantity: count, unit_price_pence: expectedPrice, net_pence: count * expectedPrice });
    }
  });

  test("reconciles amount, currency and session before allocation and enqueues one confirmation across replays", async () => {
    const item = await variant(await product(), 1);
    const order = await createOrder([line(item)]);
    const session = key("cs");
    const intent = key("pi");
    const invoice = key("in");
    await rejects(() => rpc("enqueue_order_confirmation", [order.id]), "order_not_authorised");
    await rejects(() => rpc("bind_checkout_session", [order.id, session, new Date(0)]), "checkout_session_does_not_match_hold");
    expect(await bind(order, session)).toMatchObject({ checkout_session_id: session });
    expect(await bind(order, session)).toMatchObject({ checkout_session_id: session });
    await rejects(() => bind(order, key("cs")), "checkout_session_conflict");
    await rejects(() => rpc("confirm_payment", [order.id, session, intent, order.gross_pence - 1, "GBP"]),
      "payment_amount_or_currency_mismatch");
    await rejects(() => rpc("confirm_payment", [order.id, session, intent, order.gross_pence, "USD"]),
      "payment_amount_or_currency_mismatch");
    await rejects(() => pay(order, key("cs"), intent), "payment_provider_identity_mismatch");
    expect(await reservations(order)).toEqual([{ variant_id: item.id, quantity: 1, state: "held" }]);
    expect(await outbox(order)).toEqual([]);

    const recordEvent = (event: string) => rpc("record_provider_event", [
      "stripe", event, "checkout.session.completed",
      JSON.stringify({ data: { object: { id: session, payment_intent: intent } } }),
    ]);
    const firstEvent = key("evt");
    const secondEvent = key("evt");
    await recordEvent(firstEvent);
    expect(await pay(order, session, intent)).toMatchObject({
      fulfilment_status: "ready_to_pick", payment_status: "paid", paid_pence: order.gross_pence,
    });
    await rpc("mark_provider_event", ["stripe", firstEvent, "processed"]);
    await recordEvent(secondEvent);
    expect(await pay(order, session, intent, invoice)).toMatchObject({ provider_invoice_id: invoice });
    await rpc("mark_provider_event", ["stripe", secondEvent, "processed"]);
    expect(await rpc("enqueue_order_confirmation", [order.id])).toMatchObject(confirmation(order));
    await db.query("update public.orders set hold_expires_at = now() - interval '1 minute' where id = $1", [order.id]);
    expect(await rpc("release_reservation", [order.id, key("expiry"), "expired", session])).toMatchObject({
      fulfilment_status: "ready_to_pick", payment_status: "paid",
    });
    expect(await reservations(order)).toEqual([{ variant_id: item.id, quantity: 1, state: "allocated" }]);
    expect(await stock(item)).toEqual(quantity(1, 1));
    expect(await movements(item)).toEqual([movement(item, "reserve", order, 0, 1)]);
    expect(await outbox(order)).toEqual([confirmation(order)]);
    await db.query("update public.order_outbox set state = 'sent' where order_id = $1", [order.id]);
    expect(await pay(order, session, intent)).toMatchObject({ provider_invoice_id: invoice });
    const sent = { ...confirmation(order), state: "sent" };
    expect(await rpc("enqueue_order_confirmation", [order.id])).toMatchObject(sent);
    expect(await outbox(order)).toEqual([sent]);
  });

  test("only releases an expired hold with matching provider evidence and sends late payment to review", async () => {
    const item = await variant(await product(), 1);
    const order = await createOrder([line(item)]);
    const session = key("cs");
    const intent = key("pi");
    await bind(order, session);
    const expiry = key("expiry");
    const release = (providerSession: string | null) =>
      rpc("release_reservation", [order.id, expiry, "expired", providerSession]);
    await rejects(() => release(session), "hold_not_expired");
    expect(await stock(item)).toEqual(quantity(1, 1));
    await db.query("update public.orders set hold_expires_at = now() - interval '1 minute' where id = $1", [order.id]);
    await rejects(() => release(null), "invalid_reservation_release");
    await rejects(() => release(key("cs")), "invalid_reservation_release");
    expect(await release(session)).toMatchObject({ fulfilment_status: "cancelled", payment_status: "pending" });
    expect(await release(session)).toMatchObject({ fulfilment_status: "cancelled" });
    expect(await stock(item)).toEqual(quantity(1, 0));

    const replacement = await createOrder([line(item)]);
    const expected = {
      fulfilment_status: "cancelled", payment_status: "paid", paid_pence: order.gross_pence,
      payment_review_reason: "payment_after_reservation_released",
    };
    expect(await pay(order, session, intent)).toMatchObject(expected);
    expect(await pay(order, session, intent)).toMatchObject(expected);
    expect(await reservations(order)).toEqual([{ variant_id: item.id, quantity: 1, state: "released" }]);
    expect(await reservations(replacement)).toEqual([{ variant_id: item.id, quantity: 1, state: "held" }]);
    expect(await stock(item)).toEqual(quantity(1, 1));
    expect(await movements(item)).toEqual([
      movement(item, "reserve", order, 0, 1),
      movement(item, "release", order, 0, -1),
      movement(item, "reserve", replacement, 0, 1),
    ]);
    expect(await outbox(order)).toEqual([]);
  });

  test("closes an unbound hold before cancellation and releases a paid picking order exactly once", async () => {
    const actor = await user("warehouse");
    const item = await variant(await product(), 2);
    const unbound = await createOrder([line(item, 2)]);
    const cancel = (order: Order) => rpc("cancel_order", [order.id, "staff-cancel", actor.id]);
    await rejects(() => cancel(unbound), "order_cannot_be_cancelled");
    const close = () => rpc("release_reservation", [unbound.id, "close", "closed"]);
    expect(await close()).toMatchObject({ fulfilment_status: "cancelled", checkout_session_id: null });
    expect(await close()).toMatchObject({ fulfilment_status: "cancelled" });
    expect(await cancel(unbound)).toMatchObject({ fulfilment_status: "cancelled" });
    expect(await stock(item)).toEqual(quantity(2, 0));

    const order = await createOrder([line(item, 2)]);
    const session = key("cs");
    await bind(order, session);
    await rejects(() => rpc("release_reservation", [order.id, "closed-without-id", "closed"]),
      "invalid_reservation_release");
    await pay(order, session, key("pi"));
    await rpc("start_picking", [order.id, "pick", actor.id]);
    const cancelled = { fulfilment_status: "cancelled", payment_status: "paid" };
    expect(await cancel(order)).toMatchObject(cancelled);
    expect(await cancel(order)).toMatchObject(cancelled);
    expect(await stock(item)).toEqual(quantity(2, 0));
    expect(await reservations(order)).toEqual([{ variant_id: item.id, quantity: 2, state: "released" }]);
    expect(await movements(item)).toEqual([
      movement(item, "reserve", unbound, 0, 2),
      movement(item, "release", unbound, 0, -2),
      movement(item, "reserve", order, 0, 2),
      movement(item, "release", order, 0, -2),
    ]);
  });

  test("dispatches once and keeps refunds, returned units, and inspected stock independent", async () => {
    const actor = await user("warehouse");
    const finance = await user("finance");
    const item = await variant(await product(), 2);
    const order = await createOrder([line(item, 2)]);
    const session = key("cs");
    const intent = key("pi");
    await pay(order, session, intent);
    const dispatch = (tracking = "TEST123") =>
      rpc("dispatch_order", [order.id, "dispatch", actor.id, "Parcel Carrier", tracking]);
    const returnId = randomUUID();
    const recordReturn = (id = returnId, count = 1) =>
      rpc("record_return", [order.id, id, actor.id, item.id, count, "Inspect returned blade", "OEM-45"]);
    await rejects(() => dispatch(), "order_not_picking");
    await rejects(() => recordReturn(), "order_not_dispatched");
    await rejects(() => rpc("start_picking", [order.id, "pick", finance.id]), "warehouse_role_required", "42501");
    expect(await rpc("start_picking", [order.id, "pick", actor.id])).toMatchObject({ fulfilment_status: "picking" });
    expect(await rpc("start_picking", [order.id, "pick", actor.id])).toMatchObject({ fulfilment_status: "picking" });
    const dispatched = await dispatch();
    expect(dispatched).toMatchObject({
      fulfilment_status: "dispatched", payment_status: "paid", carrier: "Parcel Carrier",
      tracking_number: "TEST123", dispatched_at: expect.any(Date),
    });
    expect(await dispatch()).toMatchObject({ dispatched_at: dispatched.dispatched_at });
    await rejects(() => dispatch("OTHER"), "operation_key_conflict");
    await rejects(() => rpc("cancel_order", [order.id, "cancel", actor.id]), "order_cannot_be_cancelled");
    expect(await reservations(order)).toEqual([{ variant_id: item.id, quantity: 2, state: "dispatched" }]);
    expect(await stock(item)).toEqual(quantity(0, 0));

    const refund = (id: string, amount: number, paymentIntent = intent) =>
      rpc("record_refund", [order.id, id, paymentIntent, amount, "GBP"]);
    const refundId = key("re");
    await rejects(() => refund(refundId, 1000, key("pi")), "refund_does_not_match_captured_payment");
    const partial = { payment_status: "partially_refunded", refunded_pence: 1000 };
    expect(await refund(refundId, 1000)).toMatchObject(partial);
    expect(await refund(refundId, 1000)).toMatchObject(partial);
    await rejects(() => refund(key("re"), order.gross_pence - 999), "refund_exceeds_captured_payment");
    expect(await refund(key("re"), order.gross_pence - 1000)).toMatchObject({
      payment_status: "refunded", refunded_pence: order.gross_pence, fulfilment_status: "dispatched",
      tracking_number: "TEST123", dispatched_at: dispatched.dispatched_at,
    });
    expect(await pay(order, session, intent)).toMatchObject({
      payment_status: "refunded", fulfilment_status: "dispatched", tracking_number: "TEST123",
      dispatched_at: dispatched.dispatched_at,
    });
    expect(await stock(item)).toEqual(quantity(0, 0));

    const returned = { id: returnId, order_id: order.id, variant_id: item.id, quantity: 1, restored_quantity: 0 };
    expect(await recordReturn()).toMatchObject(returned);
    expect(await recordReturn()).toMatchObject(returned);
    await rejects(() => recordReturn(randomUUID(), 2), "return_exceeds_dispatched_quantity");
    expect(await stock(item)).toEqual(quantity(0, 0));
    const restore = (operation: string) => rpc("restore_stock", [returnId, operation, actor.id, 1]);
    expect(await restore("inspect")).toMatchObject({ ...returned, restored_quantity: 1 });
    expect(await restore("inspect")).toMatchObject({ ...returned, restored_quantity: 1 });
    await rejects(() => restore("inspect-again"), "restore_exceeds_returned_quantity");
    expect(await stock(item)).toEqual(quantity(1, 0));

    const receipt = key("receipt");
    const receive = (count = 2) => rpc("receive_stock", [item.id, receipt, count, actor.id]);
    await rejects(() => rpc("receive_stock", [item.id, receipt, 2, null]), "warehouse_role_required", "42501");
    expect(await receive()).toMatchObject(movement(item, "receive", null, 2, 0));
    expect(await receive()).toMatchObject(movement(item, "receive", null, 2, 0));
    await rejects(() => receive(3), "operation_key_conflict");
    expect(await stock(item)).toEqual(quantity(3, 0));
    expect(await movements(item)).toEqual([
      movement(item, "reserve", order, 0, 2),
      movement(item, "dispatch", order, -2, -2),
      movement(item, "restore", order, 1, 0),
      movement(item, "receive", null, 2, 0),
    ]);
  });

  test("keeps the first provider payload, allows recovery after failure and treats processed as terminal", async () => {
    const event = key("evt");
    const payload = { id: event, data: { object: { id: key("cs") } } };
    const record = (body: object, type = "checkout.session.completed") =>
      rpc("record_provider_event", ["stripe", event, type, JSON.stringify(body)]);
    const mark = (state: string, error: string | null = null) =>
      rpc("mark_provider_event", ["stripe", event, state, error]);
    expect(await record(payload)).toMatchObject({ event_id: event, state: "received", payload });
    expect(await record({ id: event, changed: true })).toMatchObject({ state: "received", payload });
    await rejects(() => record(payload, "checkout.session.expired"), "provider_event_identity_conflict");
    expect(await mark("failed", "Provider lookup timed out")).toMatchObject({
      state: "failed", last_error: "Provider lookup timed out",
    });
    const processed = { state: "processed", last_error: null, payload };
    expect(await mark("processed")).toMatchObject(processed);
    expect(await mark("failed", "A stale worker reported failure")).toMatchObject(processed);
    expect(await record(payload)).toMatchObject(processed);
    expect(await db.query("select event_id from public.provider_events where provider = 'stripe' and event_id = $1",
      [event])).toMatchObject({ rowCount: 1 });
  });

  test("enforces buyer, guest, and staff visibility on both orders and line items", async () => {
    const buyer = await user();
    const other = await user();
    const actor = await user("warehouse");
    const finance = await user("finance");
    const catalogue = await user("catalogue");
    const item = await variant(await product(), 3);
    const own = await createOrder([line(item)], { buyer: buyer.id, email: buyer.email });
    const otherOrder = await createOrder([line(item)], { buyer: other.id, email: other.email });
    const guest = await createOrder([line(item)], { email: buyer.email });
    await pay(guest, key("cs"), key("pi"));
    const ids = [own.id, otherOrder.id, guest.id];
    const checkRead = async (identity: string, readable: string[]) => {
      await asRole("authenticated", identity, async () => {
        const orders = await db.query("select id from public.orders where id = any($1::uuid[]) order by id", [ids]);
        const items = await db.query(`
          select order_id from public.order_items where order_id = any($1::uuid[]) order by order_id
        `, [ids]);
        expect(orders.rows.map(({ id }) => id)).toEqual([...readable].sort());
        expect(items.rows.map(({ order_id }) => order_id)).toEqual([...readable].sort());
      });
    };
    await checkRead(buyer.id, [own.id]);
    await checkRead(other.id, [otherOrder.id]);
    await checkRead(actor.id, [guest.id]);
    await checkRead(finance.id, ids);
    await checkRead(catalogue.id, []);

    await asRole("anon", null, async () => {
      await rejects(() => db.query("select id from public.orders where id = $1", [guest.id]),
        "permission denied for table orders", "42501");
      await rejects(() => db.query("select order_id from public.order_items where order_id = $1", [guest.id]),
        "permission denied for table order_items", "42501");
    });
    await asRole("authenticated", buyer.id, async () => {
      await rejects(() => db.query("update public.orders set fulfilment_status = 'cancelled' where id = $1", [own.id]),
        "permission denied for table orders", "42501");
      await rejects(() => db.query("update public.order_items set quantity = 2 where order_id = $1", [own.id]),
        "permission denied for table order_items", "42501");
      await rejects(() => db.query("insert into public.staff_members (user_id, role) values ($1, 'finance')", [buyer.id]),
        "permission denied for table staff_members", "42501");
    });
  });

  test("each order, stock and provider mutation RPC is executable only by the service API role", async () => {
    const names = [
      "bind_checkout_session", "cancel_order", "confirm_payment", "create_order_with_reservations", "dispatch_order",
      "enqueue_order_confirmation", "mark_provider_event", "receive_stock", "record_provider_event", "record_refund",
      "record_return", "release_reservation", "restore_stock", "start_picking",
    ];
    const { rows } = await db.query(`
      select p.proname as name,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
        exists (
          select from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "public"
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
      order by p.proname
    `, [names]);
    expect(rows).toEqual(names.map((name) => ({
      name, anon: false, authenticated: false, service: true, public: false,
    })));
    const { rows: writeGrants } = await db.query(`
      select privilege, has_any_column_privilege('authenticated', target, privilege) as allowed
      from unnest(array['public.orders', 'public.order_items']) target
      cross join unnest(array['INSERT', 'UPDATE']) privilege
      union all
      select 'DELETE', has_table_privilege('authenticated', target, 'DELETE')
      from unnest(array['public.orders', 'public.order_items']) target
    `);
    expect(writeGrants).toHaveLength(6);
    expect(writeGrants.every(({ allowed }) => allowed === false)).toBe(true);
    const stockWrites = await one(db, `
      select
        has_column_privilege('service_role', 'public.variants', 'stock_on_hand', 'INSERT') as stock_insert,
        has_column_privilege('service_role', 'public.variants', 'stock_on_hand', 'UPDATE') as stock_update,
        has_column_privilege('service_role', 'public.variants', 'stock_reserved', 'UPDATE') as reserved_update,
        has_column_privilege('service_role', 'public.variants', 'price_1_4_pence', 'UPDATE') as catalogue_update,
        has_table_privilege('service_role', 'public.order_items', 'UPDATE') as item_update
    `);
    expect(stockWrites).toEqual({
      stock_insert: false, stock_update: false, reserved_update: false, catalogue_update: true, item_update: false,
    });
  });
});

test.each([
  { label: "two distinct attempts compete for one unit", sameAttempt: false },
  { label: "concurrent submissions of one attempt replay", sameAttempt: true },
])("$label", async ({ sameAttempt }) => {
  const first = randomUUID();
  const second = sameAttempt ? first : randomUUID();
  const tokens = [first, second];
  const family = await product();
  const workers: Client[] = [];
  try {
    const item = await variant(family, 1);
    for (let i = 0; i < 2; i++) workers.push(await connect());
    const pids = await Promise.all(workers.map(async (client) => {
      await client.query("set role service_role");
      return (await one<{ pid: number }>(client, "select pg_backend_pid() as pid")).pid;
    }));
    const barrierPid = (await one<{ pid: number }>(db, "select pg_backend_pid() as pid")).pid;
    await db.query("begin");
    let results: Promise<PromiseSettledResult<Order>[]> | undefined;
    try {
      await db.query("select id from public.variants where id = $1 for update", [item.id]);
      results = Promise.allSettled(workers.map((client, i) =>
        createOrder([line(item)], { token: tokens[i]! }, client)));
      await expect.poll(async () => {
        const { rows } = await db.query<{ pid: number; blockers: number[] }>(`
          select pid, pg_blocking_pids(pid) as blockers from unnest($1::int[]) as pid
        `, [pids]);
        return {
          waiting: rows.filter(({ blockers }) => blockers.length > 0).length,
          behindBarrier: rows.some(({ blockers }) => blockers.includes(barrierPid)),
        };
      }, { timeout: 4000 }).toEqual({ waiting: 2, behindBarrier: true });
    } finally {
      await db.query("rollback");
      await results;
    }

    const outcomes = await results;
    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(successes).toHaveLength(sameAttempt ? 2 : 1);
    const order = successes[0]!.value;
    if (sameAttempt) {
      expect(successes.map(({ value }) => value.id)).toEqual([order.id, order.id]);
    } else {
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(failures.map(({ reason }) => reason)).toEqual([
        expect.objectContaining({ code: "P0001", message: "insufficient_stock", detail: item.id }),
      ]);
    }
    const persisted = await db.query("select id from public.orders where checkout_attempt_token = any($1::uuid[])",
      [tokens]);
    expect(persisted.rows).toEqual([{ id: order.id }]);
    expect(await reservations(order)).toEqual([{ variant_id: item.id, quantity: 1, state: "held" }]);
    expect(await movements(item)).toEqual([movement(item, "reserve", order, 0, 1)]);
    expect(await stock(item)).toEqual(quantity(1, 1));
    expect(await rpc("release_reservation", [order.id, "close-winner", "closed"])).toMatchObject({ fulfilment_status: "cancelled" });
    expect(await stock(item)).toEqual(quantity(1, 0));
    expect(await reservations(order)).toEqual([{ variant_id: item.id, quantity: 1, state: "released" }]);
  } finally {
    await Promise.all(workers.map((client) => client.end()));
    await db.query("begin");
    try {
      for (const table of [
        "private.order_operations", "public.order_outbox", "public.stock_movements", "public.stock_reservations",
        "public.order_returns", "public.order_items",
      ]) {
        await db.query(`delete from ${table} where order_id in (
          select id from public.orders where checkout_attempt_token = any($1::uuid[])
        )`, [tokens]);
      }
      await db.query("delete from public.orders where checkout_attempt_token = any($1::uuid[])", [tokens]);
      await db.query("delete from public.variants where product_id = $1", [family]);
      await db.query("delete from public.products where id = $1", [family]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  }
});
