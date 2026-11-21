import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifest = "private.demo_orders_fixture";
const identity = {
  buyer: "64ab6d8c-72b4-4a2b-96f1-f76eef54ebcd",
  application: "74a0134c-d348-4142-8154-cad666ce0bfa",
};
const demoIds = "select jsonb_array_elements_text($1::jsonb->'orders')::uuid";
const byOrder = `t.order_id in (${demoIds})`;
const byAccount = "t.trade_account_id = ($1::jsonb->>'account')::uuid";
const graph = [
  ["public.stock_movements", byOrder],
  ["public.stock_reservations", byOrder],
  ["private.order_operations", byOrder],
  ["public.credit_ledger", byAccount],
  ["public.credit_holds", byOrder],
  ["public.invoices", byOrder],
  ["public.order_items", byOrder],
  ["public.orders", `t.id in (${demoIds})`],
  ["public.trade_accounts", "t.id = ($1::jsonb->>'account')::uuid"],
  ["public.trade_applications", "t.id = ($1::jsonb->>'application')::uuid"],
  ["auth.users", "t.id = ($1::jsonb->>'buyer')::uuid"],
];

function refuse(message) {
  const error = new Error(message);
  error.name = "DemoOrdersRefusal";
  throw error;
}

async function snapshot(db, scope) {
  const fingerprints = {};
  for (const [table, where] of graph) {
    const { rows: [{ data }] } = await db.query(`
      select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)), '[]')::text as data
      from ${table} t where ${where}
    `, [scope]);
    fingerprints[table] = createHash("sha256").update(data).digest("hex");
  }
  return fingerprints;
}

async function assertUntrackedFixtureAbsent(db) {
  const { rows: [{ found }] } = await db.query(`
    select exists (select from public.orders where email like '%@edgey-orders-demo.invalid')
      or exists (select from public.trade_applications where id = $2 or email like '%@edgey-orders-demo.invalid')
      or exists (select from auth.users where id = $1 or email like '%@edgey-orders-demo.invalid') as found
  `, [identity.buyer, identity.application]);
  if (found) refuse("Found demo identities without a manifest. No rows were changed; investigate the original fixture before proceeding.");
}

async function loadDemo(db) {
  await assertUntrackedFixtureAbsent(db);
  await db.query(`
    select set_config('edgey.demo_buyer_id', $1, true), set_config('edgey.demo_application_id', $2, true)
  `, [identity.buyer, identity.application]);
  await db.query(readFileSync(new URL("./demo-orders-load.sql", import.meta.url), "utf8"));
  const { rows: [loaded] } = await db.query(`
    select array(select id from pg_temp.demo_order_ids order by id) as orders,
      (select id from public.trade_accounts where application_id = $1) as account
  `, [identity.application]);
  const scope = { ...identity, ...loaded };
  if (!scope.orders.length || !scope.account) refuse("The demo transaction did not create a complete order batch.");
  await assertNoWorkerTasks(db, scope);
  const { rows } = await db.query(`select distinct variant_id from public.stock_movements t where ${byOrder}`, [scope]);
  await assertStocksAgree(db, rows.map(({ variant_id }) => variant_id));
  await db.query(`
    insert into ${manifest} (version, fixture_scope, fingerprint) values (1, $1, $2)
  `, [scope, await snapshot(db, scope)]);
  return `Loaded ${scope.orders.length} [DEMO] orders across ten UK weeks.`;
}

async function assertNoWorkerTasks(db, scope) {
  const { rows: [{ found }] } = await db.query(`
    select exists (select from public.order_outbox t where ${byOrder}
        or trade_application_id = ($1::jsonb->>'application')::uuid)
      or exists (select from public.finance_retry_requests
        where kind = 'confirmation' and target_id in (select unnest(array(${demoIds}))::text))
      or exists (select from public.orders where id in (${demoIds})
        and stripe_replay_after <> 'infinity'::timestamptz) as found
  `, [scope]);
  if (found) refuse("The demo has unexpected email work or reconciliation settings. No rows were changed.");
}

async function assertStocksAgree(db, variants) {
  const { rows: [{ mismatch }] } = await db.query(`
    select exists (
      select from public.variants v
      cross join lateral (
        select coalesce(sum(on_hand_delta), 0) as hand, coalesce(sum(reserved_delta), 0) as reserved
        from public.stock_movements where variant_id = v.id
      ) m
      where v.id = any($1::uuid[]) and (
        (v.stock_on_hand, v.stock_reserved) is distinct from (m.hand, m.reserved)
        or v.stock_reserved is distinct from (
          select coalesce(sum(quantity), 0) from (
            select quantity from public.stock_reservations where variant_id = v.id and state in ('held', 'allocated')
            union all
            select a.quantity from public.trial_allocations a join public.trial_fulfilments f using (trial_request_id)
            where a.variant_id = v.id and f.state = 'allocated'
          ) reserved
        )
      )
    ) as mismatch
  `, [variants]);
  if (mismatch) refuse("Stock counters do not agree with the movement ledger and active reservations. No rows were changed.");
}

async function assertNoCascadingReferences(db, table, where, scope) {
  const { rows } = await db.query(`
    select format('select exists (select from %I.%I c join %s t on %s where %s) as found',
      ns.nspname, child.relname, fk.confrelid::regclass, columns.join_on, $2::text) as check_sql
    from pg_constraint fk
    join pg_class child on child.oid = fk.conrelid
    join pg_namespace ns on ns.oid = child.relnamespace
    cross join lateral (
      select string_agg(format('c.%I = t.%I', ca.attname, pa.attname), ' and ') as join_on
      from unnest(fk.conkey, fk.confkey) as k(child_att, parent_att)
      join pg_attribute ca on ca.attrelid = fk.conrelid and ca.attnum = k.child_att
      join pg_attribute pa on pa.attrelid = fk.confrelid and pa.attnum = k.parent_att
    ) columns
    where fk.confrelid = $1::regclass and fk.contype = 'f' and fk.confdeltype in ('c', 'd', 'n')
  `, [table, where]);
  for (const { check_sql: sql } of rows) {
    const { rows: [{ found }] } = await db.query(sql, [scope]);
    if (found) refuse(`Unexpected records reference the demo rows in ${table}. No rows were changed.`);
  }
}

async function cleanDemo(db, { version, fixture_scope: scope, fingerprint }) {
  if (version !== 1 || scope?.buyer !== identity.buyer || scope?.application !== identity.application ||
      !Array.isArray(scope.orders) || !scope.orders.length || !scope.account) {
    refuse("The demo manifest was not recognised. No rows were changed.");
  }
  for (const [table, where] of [...graph].reverse()) {
    await db.query(`select 1 from ${table} t where ${where} for update`, [scope]);
  }
  const current = await snapshot(db, scope);
  for (const [table] of graph) {
    if (current[table] !== fingerprint[table]) {
      refuse(`The demo rows in ${table} changed since loading. No rows were changed; investigate before cleaning.`);
    }
  }
  await assertNoWorkerTasks(db, scope);

  const { rows: locked } = await db.query(`
    select id from public.variants where id in (
      select variant_id from public.stock_movements t where ${byOrder}
    ) order by id for no key update
  `, [scope]);
  const variants = locked.map(({ id }) => id);
  await assertStocksAgree(db, variants);
  const { rows: [{ found: corrected }] } = await db.query(`
    select exists (
      select from public.stock_movements m join (
        select variant_id, min(id) as first_fixture_id from public.stock_movements t
        where ${byOrder} group by variant_id
      ) demo using (variant_id)
      where m.id > demo.first_fixture_id and m.adjustment_reason = 'count_correction'
    ) as found
  `, [scope]);
  if (corrected) refuse("A demo SKU was physically count-corrected after loading. No rows were changed; reconcile that stock before cleaning.");
  await db.query(`
    with delta as (
      select variant_id, sum(on_hand_delta) as on_hand, sum(reserved_delta) as reserved
      from public.stock_movements t where ${byOrder} group by variant_id
    )
    update public.variants v
    set stock_on_hand = v.stock_on_hand - delta.on_hand, stock_reserved = v.stock_reserved - delta.reserved
    from delta where v.id = delta.variant_id
  `, [scope]);

  for (const [table, where] of graph) {
    await assertNoCascadingReferences(db, table, where, scope);
    await db.query(`delete from ${table} t where ${where}`, [scope]);
  }
  await assertStocksAgree(db, variants);
  await db.query(`delete from ${manifest} where version = 1`);
  return `Removed ${scope.orders.length} [DEMO] orders and reversed only their stock movements.`;
}

export async function runDemoOrders(db, mode) {
  try {
    await db.query(`
      begin;
      set local lock_timeout = '5s';
      set local statement_timeout = '30s';
      set local time zone 'UTC';
      set local search_path = pg_catalog, public;
      select pg_advisory_xact_lock(hashtextextended('edgey:demo-orders', 0))
    `);
    const { rows: [{ present }] } = await db.query(`select to_regclass('${manifest}') is not null as present`);
    if (!present && mode === "load") {
      await db.query(`
        create table ${manifest} (
          version smallint primary key check (version = 1),
          fixture_scope jsonb not null,
          fingerprint jsonb not null
        );
        alter table ${manifest} enable row level security;
        revoke all on ${manifest} from public, anon, authenticated, service_role;
      `);
    }
    const { rows: [batch] } = present ? await db.query(`select * from ${manifest} for update`) : { rows: [] };
    let result;
    if (mode === "load") {
      if (batch) refuse("Demo orders are already loaded. Clean the existing fixture before loading another batch.");
      result = await loadDemo(db);
    } else if (batch) {
      result = await cleanDemo(db, batch);
    } else {
      await assertUntrackedFixtureAbsent(db);
      result = "No demo order batch is loaded.";
    }
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback").catch(() => {});
    if (error.message === "demo_stock_unavailable") {
      refuse(`Load refused: the published staging fixture needs ${error.detail}. No stock or orders were changed.`);
    }
    if (error.message === "demo_delivery_terms_missing") refuse(error.detail);
    if (error.message === "demo_stock_ledger_mismatch") refuse("Stock counters do not agree with the movement ledger. No rows were changed.");
    if (error.code === "23503") refuse("A related record prevents this fixture operation. No rows were changed; investigate before retrying.");
    if (error.code === "55P03" || error.code === "40P01") refuse("The database is busy. No rows were changed; retry when order and stock activity is quiet.");
    throw error;
  }
}
