import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Client } from "pg";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const demo = "email like '%@edgey-orders-demo.invalid'";

test("loads ten weeks of worker-safe orders and reverses only the unmodified fixture", async () => {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString || !["127.0.0.1", "localhost"].includes(new URL(connectionString).hostname)) {
    throw new Error("Run pnpm db:start && pnpm db:env && pnpm db:fixture against local Supabase.");
  }
  const db = new Client({ connectionString });
  const cli = (mode: "load" | "clean") => exec(process.execPath, ["scripts/demo-orders.mjs", mode, "--local"]);
  const actor = randomUUID();
  const real: string[] = [];
  let loaded = false;
  const stock = async () => (await db.query(
    "select sku, stock_on_hand, stock_reserved from public.variants order by sku",
  )).rows;
  const realState = async () => (await db.query(`
    select o.id, to_jsonb(o) as purchase, to_jsonb(r) as reservation,
      (select jsonb_agg(to_jsonb(m) order by m.id) from public.stock_movements m where m.order_id = o.id) as movements
    from public.orders o join public.stock_reservations r on r.order_id = o.id
    where o.id = any($1::uuid[]) order by o.id
  `, [real])).rows;

  async function reserve(quantity: number) {
    const { rows: [order] } = await db.query<{ id: string; gross_pence: number }>(`
      with basket as (
        select id, $1::int as qty, case when $1 >= 10 then price_10_plus_pence else price_1_4_pence end as unit,
          public.checkout_delivery_terms('SW9 9ZZ') as terms
        from public.variants where sku = 'EDG-Z10'
      ), money as (
        select *, qty * unit as goods, case when qty * unit < 15000 then 695 else 0 end as delivery from basket
      ), priced as (
        select *, round(goods * 0.2) + round(delivery * 0.2) as vat from money
      )
      select o.id, o.gross_pence from priced
      cross join lateral public.reserve_order_with_delivery(
        gen_random_uuid(), jsonb_build_array(jsonb_build_object('variant_id', id, 'quantity', qty, 'unit_price_pence', unit)),
        jsonb_build_object('email', 'preserve-' || gen_random_uuid() || '@example.test', 'business_name', 'Preserve me',
          'recipient_name', 'Test buyer', 'buying_for_work', true),
        '{"line1":"1 Placeholder Yard","town":"London","postcode":"SW9 9ZZ","country":"GB"}',
        jsonb_build_object('goods_net_pence', goods, 'delivery_net_pence', delivery, 'vat_rate_bps', 2000,
          'vat_pence', vat, 'gross_pence', goods + delivery + vat),
        now() + interval '35 minutes', terms->'quote'->>'serviceName', current_date, current_date + 1, terms, 'card'
      ) o
    `, [quantity]);
    real.push(order!.id);
    return order!;
  }

  await db.connect();
  try {
    const initial = await stock();
    const z10 = initial.find(({ sku }) => sku === "EDG-Z10")!;
    const blocker = await reserve(z10.stock_on_hand - z10.stock_reserved);
    const blocked = await stock();
    await expect(cli("load")).rejects.toMatchObject({ stderr: expect.stringContaining("EDG-Z10 (13 free)") });
    expect(await stock()).toEqual(blocked);
    expect((await db.query(`select id from public.orders where ${demo}`)).rowCount).toBe(0);
    await db.query("select public.release_reservation($1, 'test-close', 'closed')", [blocker.id]);

    const concurrent = await Promise.allSettled([cli("load"), cli("load")]);
    expect(concurrent).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ stdout: expect.stringContaining("Loaded 15") }) }),
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ stderr: expect.stringContaining("already loaded") }) }),
    ]));
    loaded = true;
    const { rows: [state] } = await db.query(`
      select count(*)::int as orders,
        count(distinct date_trunc('week', o.created_at at time zone 'Europe/London'))::int as weeks,
        count(distinct case when quantity < 5 then 1 when quantity < 10 then 5 else 10 end)::int as tiers,
        bool_and(o.business_name like '[DEMO] %' and o.address_line1 like '%DO NOT SHIP') as visibly_demo,
        bool_and(o.stripe_replay_after = 'infinity'::timestamptz) as excluded_from_replay,
        bool_and(o.fulfilment_status <> 'dispatched' or o.created_at <= o.authorised_at and o.authorised_at <= o.dispatched_at) as ordered,
        bool_and(i.unit_price_pence = case when quantity < 5 then v.price_1_4_pence
          when quantity < 10 then v.price_5_9_pence else v.price_10_plus_pence end) as prices_match,
        count(distinct v.id)::int as skus,
        array_agg(distinct o.fulfilment_status::text) as states,
        array_agg(distinct o.payment_status::text) as payments
      from public.orders o join public.order_items i on i.order_id = o.id
      join public.variants v on v.id = i.variant_id where o.${demo}
    `);
    expect(state).toEqual({
      orders: 15, weeks: 10, tiers: 3, visibly_demo: true, excluded_from_replay: true, ordered: true, prices_match: true, skus: 9,
      states: ["cancelled", "dispatched"],
      payments: ["invoiced", "paid", "partially_paid", "partially_refunded", "pending", "refunded"],
    });
    const { rows: [workers] } = await db.query(`
      select (select count(*)::int from public.order_outbox m
        left join public.orders o on m.order_id = o.id
        left join public.trade_applications a on m.trade_application_id = a.id
        where o.${demo} or a.${demo}) as emails,
      (select count(*)::int from public.invoices i join public.orders o on o.id = i.order_id
        where o.${demo} and amount_remaining_pence > 0 and due_at < now()) as overdue,
      (select count(*)::int from auth.users u join public.staff_members s on s.user_id = u.id
        where u.${demo}) as staff
    `);
    expect(workers).toEqual({ emails: 0, overdue: 1, staff: 0 });

    const shipped = await reserve(1);
    const capture = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [actor, `warehouse-${actor}@example.test`]);
    await db.query("insert into public.staff_members (user_id, role) values ($1, 'warehouse')", [actor]);
    await db.query("select public.confirm_payment($1, $2, $2, $3, 'GBP', now(), current_date, current_date + 1)",
      [shipped.id, capture, shipped.gross_pence]);
    await db.query("select public.start_picking($1, 'preserve-pick', $2)", [shipped.id, actor]);
    await db.query("select public.dispatch_order($1, 'preserve-dispatch', $2, 'Test carrier', 'PRESERVE')", [shipped.id, actor]);
    await reserve(1);
    const beforeClean = await realState();
    const stockBeforeClean = await stock();

    const { rows: [item] } = await db.query<{ order_id: string; option_label: string }>(`
      select order_id, option_label from public.order_items where order_id = (select id from public.orders where ${demo} limit 1)
    `);
    await db.query("update public.order_items set option_label = 'changed' where order_id = $1", [item!.order_id]);
    try {
      await expect(cli("clean")).rejects.toMatchObject({ stderr: expect.stringContaining("public.order_items changed") });
      expect(await stock()).toEqual(stockBeforeClean);
    } finally {
      await db.query("update public.order_items set option_label = $2 where order_id = $1", [item!.order_id, item!.option_label]);
    }
    const { rows: [event] } = await db.query<{ id: string }>("insert into public.finder_search_events (outcome) values ('exact') returning id");
    try {
      await db.query("insert into private.finder_order_attributions (event_id, order_id) values ($1, $2)", [event!.id, item!.order_id]);
      await expect(cli("clean")).rejects.toMatchObject({ stderr: expect.stringContaining("Unexpected records reference the demo") });
      expect(await stock()).toEqual(stockBeforeClean);
      expect((await db.query("select order_id from private.finder_order_attributions where event_id = $1", [event!.id])).rowCount).toBe(1);
    } finally {
      await db.query("delete from public.finder_search_events where id = $1", [event!.id]);
    }

    expect((await cli("clean")).stdout).toContain("Removed 15");
    loaded = false;
    expect((await cli("clean")).stdout).toContain("No demo order batch");
    expect((await db.query(`select id from public.orders where ${demo}`)).rowCount).toBe(0);
    expect(await realState()).toEqual(beforeClean);
    expect(await stock()).toEqual(initial.map((row) => row.sku === "EDG-Z10" ? {
      ...row, stock_on_hand: row.stock_on_hand - 1, stock_reserved: row.stock_reserved + 1,
    } : row));
  } finally {
    try {
      if (loaded) await cli("clean");
    } finally {
      await db.query("begin");
      await db.query(`
        with delta as (
          select variant_id, sum(on_hand_delta) as hand, sum(reserved_delta) as reserved
          from public.stock_movements where order_id = any($1::uuid[]) group by variant_id
        )
        update public.variants v set stock_on_hand = stock_on_hand - hand, stock_reserved = stock_reserved - reserved
        from delta where v.id = delta.variant_id
      `, [real]);
      for (const table of ["public.order_outbox", "public.stock_movements", "public.stock_reservations", "private.order_operations", "public.order_items"]) {
        await db.query(`delete from ${table} where order_id = any($1::uuid[])`, [real]);
      }
      await db.query("delete from public.orders where id = any($1::uuid[])", [real]);
      await db.query("delete from auth.users where id = $1", [actor]);
      await db.query("commit");
      await db.end();
    }
  }
});
