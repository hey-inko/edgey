import { randomBytes, randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

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

async function one<R extends QueryResultRow>(sql: string, args: unknown[] = [], client = db) {
  const { rows } = await client.query<R>(sql, args);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const rpc = async <T = string>(name: string, args: unknown[], client = db) =>
  (await one<{ result: T }>(
    `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args, client,
  )).result;

async function asRole<T>(role: "anon" | "authenticated" | "service_role", run: () => Promise<T>, id?: string) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, sub: id })]);
  await db.query(`set local role ${role}`);
  const result = await run();
  await db.query("reset role");
  return result;
}

async function rejects(query: () => Promise<unknown>, code: string, message?: string) {
  await db.query("savepoint expect_request_error");
  try {
    await expect(query()).rejects.toMatchObject(message ? { code, message } : { code });
  } finally {
    await db.query("rollback to savepoint expect_request_error");
    await db.query("release savepoint expect_request_error");
  }
}

async function user(role?: "warehouse" | "catalogue" | "finance", verified = true) {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, $3)", [
    id, email, verified ? new Date() : null,
  ]);
  if (role) await db.query("insert into public.staff_members (user_id, role) values ($1, $2)", [id, role]);
  return { id, email };
}

const contactEmail = "trial@example.test";
const postcode = "SW1A 1AA";
const enquiry = (id: string, email = contactEmail) =>
  rpc("submit_enquiry", [id, "compatibility", email, "Which blade fits?"]);
const trial = (id: string, email = contactEmail) =>
  rpc("submit_trial_request", [id, "zund", "unknown", email, "Test Fabrication", postcode]);
const trade = (id: string, buyer: string, company = "Test Fabrication") => rpc("submit_trade_application", [
  id, buyer, "Test Buyer", company, "1 Test Street", "London", postcode,
]);
const hex = () => randomBytes(32).toString("hex");
const delivery = { recipient_name: "Test Buyer", line1: "1 Test Street", town: "London", postcode, country: "GB" };
const approve = (
  id: string, actor: string, variants: string[], address = delivery, verified = true, service = "Standard",
) => rpc("approve_trial_fulfilment", [id, actor, variants, address, "Test Carrier", service, verified]);

async function outbox(requestId: string) {
  return (await db.query(`
    select id, message_key, state from public.order_outbox
    where $1 in (enquiry_id, trial_request_id, trade_application_id) order by message_key
  `, [requestId])).rows;
}

async function variant(quantity: number, actor: string) {
  const id = randomUUID();
  const sku = `request-test-${id}`;
  const product = await one<{ id: string }>(`
    insert into public.products (family_code, slug, name, tool_category)
    values ($1, $1, 'Request test family', 'oscillating') returning id
  `, [sku]);
  await db.query(`
    insert into public.variants (id, product_id, sku, supplier_part_number, evidence_source, approved_at,
      publication_status, price_1_4_pence, price_5_9_pence, price_10_plus_pence)
    values ($1, $2, $3, $3, 'DB test fixture', now(), 'published', 1000, 900, 800)
  `, [id, product.id, sku]);
  if (quantity > 0) await asRole("service_role", () => rpc("receive_stock", [id, sku, quantity, actor]));
  return id;
}

const stock = (id: string) =>
  one("select stock_on_hand, stock_reserved from public.variants where id = $1", [id]);

const order = async (variantId: string, email = contactEmail, buyerId?: string) => one<{ id: string }>(`
  select id from public.create_order_with_reservations(
    $1, $2, $3, $4, $5, clock_timestamp() + interval '30 minutes', 'Standard',
    current_date + 1, current_date + 2, $6
  )
`, [
  randomUUID(),
  JSON.stringify([{ variant_id: variantId, quantity: 1, unit_price_pence: 1000 }]),
  JSON.stringify({ email, business_name: "Test Fabrication", recipient_name: "Test Buyer", buying_for_work: true }),
  JSON.stringify({ line1: delivery.line1, town: delivery.town, postcode, country: "GB" }),
  JSON.stringify({ goods_net_pence: 1000, delivery_net_pence: 0, vat_rate_bps: 2000, vat_pence: 200, gross_pence: 1200 }),
  buyerId ?? null,
]);

const pay = (id: string) => one(`
  select id from public.confirm_payment($1, $2, $3, 1200, 'GBP', clock_timestamp(),
    current_date + 1, current_date + 2, null)
`, [id, randomUUID(), randomUUID()]);

describe("request data and permissions", () => {
  beforeEach(() => db.query("begin"));
  afterEach(() => db.query("rollback"));

  test("denies anonymous table, submission, limiter and analytics access", async () => {
    await asRole("anon", async () => {
      for (const table of ["enquiries", "trial_requests", "trade_applications", "trial_fulfilments",
        "trial_allocations", "finder_search_events", "order_outbox"]) {
        await rejects(() => db.query(`select * from public.${table}`), "42501");
        await rejects(() => db.query(`insert into public.${table} default values`), "42501");
      }
      await rejects(() => enquiry(randomUUID()), "42501");
      await rejects(() => trial(randomUUID()), "42501");
      await rejects(() => trade(randomUUID(), randomUUID()), "42501");
      await rejects(() => rpc("consume_request_rate_limit", ["enquiry", hex(), hex()]), "42501");
      await rejects(() => rpc("record_finder_search", ["exact", "EDGZ10"]), "42501");
      await rejects(() => rpc("purge_request_data", ["1 day", "1 day", "1 day", "1 day"]), "42501");
    });
  });

  test("isolates buyer applications and role-scopes staff review without opening credit or editable identities", async () => {
    const buyer = await user();
    const otherBuyer = await user();
    const unverified = await user(undefined, false);
    const catalogue = await user("catalogue");
    const warehouse = await user("warehouse");
    const finance = await user("finance");
    const buyerApplication = randomUUID();
    const otherApplication = randomUUID();
    const enquiryId = randomUUID();
    const trialId = randomUUID();
    await asRole("service_role", async () => {
      await rejects(() => trade(randomUUID(), unverified.id), "42501", "verified_buyer_required");
      await trade(buyerApplication, buyer.id);
      await trade(otherApplication, otherBuyer.id);
      await enquiry(enquiryId);
      await trial(trialId);
      await rejects(() => rpc("review_trade_application", [buyerApplication, warehouse.id, "approved"]),
        "42501", "finance_role_required");
    });

    await asRole("authenticated", async () => {
      expect((await db.query("select id, email, status from public.trade_applications where id in ($1, $2)",
        [buyerApplication, otherApplication])).rows).toEqual([
        { id: buyerApplication, email: buyer.email, status: "pending" },
      ]);
      expect((await db.query("select id from public.enquiries where id = $1", [enquiryId])).rows).toEqual([]);
      expect((await db.query("select id from public.trial_requests where id = $1", [trialId])).rows).toEqual([]);
      await rejects(() => db.query("select reviewed_by from public.trade_applications where id = $1",
        [buyerApplication]), "42501");
      await rejects(() => db.query("update public.trade_applications set status = 'approved' where id = $1",
        [buyerApplication]), "42501");
      await rejects(() => db.query("update public.orders set payment_method = 'net30' where buyer_id = $1",
        [buyer.id]), "42501");
      await rejects(() => rpc("review_trade_application", [buyerApplication, finance.id, "approved"]), "42501");
      await rejects(() => order(randomUUID(), buyer.email, buyer.id), "42501");
    }, buyer.id);
    for (const staff of [catalogue, warehouse]) {
      await asRole("authenticated", async () => {
        expect((await db.query("update public.enquiries set status = 'in_review' where id = $1",
          [enquiryId])).rowCount).toBe(1);
        expect((await db.query("update public.trial_requests set staff_notes = 'Checking fit' where id = $1",
          [trialId])).rowCount).toBe(1);
        await rejects(() => db.query("update public.trial_requests set status = 'approved' where id = $1",
          [trialId]), "42501");
        await rejects(() => db.query("update public.trial_requests set email = 'new@example.test' where id = $1",
          [trialId]), "42501");
        expect((await db.query("select id from public.trade_applications where id = $1", [buyerApplication])).rows)
          .toEqual([]);
      }, staff.id);
    }
    await asRole("authenticated", async () => {
      expect((await db.query("select id from public.trade_applications where id in ($1, $2)",
        [buyerApplication, otherApplication])).rowCount).toBe(2);
      expect(await outbox(buyerApplication)).toEqual([]);
      expect((await db.query("select id from public.enquiries where id = $1", [enquiryId])).rows).toEqual([]);
      await rejects(() => rpc("review_trade_application", [buyerApplication, finance.id, "approved"]), "42501");
    }, finance.id);
    await asRole("service_role", async () => {
      expect(await rpc("review_trade_application", [buyerApplication, finance.id, "approved"])).toBe(buyerApplication);
      expect(await rpc("review_trade_application", [buyerApplication, finance.id, "approved"])).toBe(buyerApplication);
      await rejects(() => rpc("review_trade_application", [buyerApplication, finance.id, "rejected"]),
        "22023", "trade_application_not_reviewable");
    });
    await asRole("authenticated", async () => {
      expect(await one("select status from public.trade_applications where id = $1", [buyerApplication]))
        .toEqual({ status: "approved" });
      await rejects(() => order(randomUUID(), buyer.email, buyer.id), "42501");
    }, buyer.id);
  });

  test("submits request and mail atomically, and replays without replacing the request or queue state", async () => {
    const buyer = await user();
    const otherBuyer = await user();
    const enquiries = randomUUID();
    const trials = randomUUID();
    const application = randomUUID();
    await asRole("service_role", async () => {
      await rejects(() => db.query("insert into public.enquiries default values"), "42501");
      await rejects(() => rpc("submit_enquiry", [enquiries, "delivery", contactEmail, "Can you deliver?"]), "23514");
      expect(await outbox(enquiries)).toEqual([]);
      expect(await enquiry(enquiries)).toBe(enquiries);
      expect(await trial(trials)).toBe(trials);
      expect(await trade(application, buyer.id)).toBe(application);
      for (const id of [enquiries, trials, application]) {
        expect(await outbox(id)).toEqual([
          { id: expect.any(String), message_key: "confirmation", state: "pending" },
          { id: expect.any(String), message_key: "staff_notification", state: "pending" },
        ]);
      }
      const [confirmation, staff] = await outbox(enquiries);
      await db.query("update public.order_outbox set state = 'sent' where id = $1", [confirmation.id]);
      await db.query("update public.order_outbox set state = 'failed' where id = $1", [staff.id]);
      await rejects(() => db.query("update public.order_outbox set enquiry_id = null where id = $1",
        [confirmation.id]), "42501");
      expect(await enquiry(enquiries)).toBe(enquiries);
      expect(await outbox(enquiries)).toEqual([
        { ...confirmation, state: "sent" },
        { ...staff, state: "failed" },
      ]);
      await db.query("update public.order_outbox set state = 'pending' where id = $1 and state = 'failed'", [staff.id]);
      expect(await outbox(enquiries)).toEqual([{ ...confirmation, state: "sent" }, staff]);
      expect(await trial(trials)).toBe(trials);
      expect(await trade(application, buyer.id)).toBe(application);
      await rejects(() => trade(randomUUID(), buyer.id, "Superseded draft"), "23505", "trade_application_exists");
      await rejects(() => trade(application, buyer.id, "Different payload"), "22023", "request_attempt_conflict");
      await rejects(() => trade(application, otherBuyer.id), "22023", "request_attempt_conflict");
      await rejects(() => enquiry(enquiries, "changed@example.test"), "22023", "request_attempt_conflict");
      await rejects(() => trial(trials, "changed@example.test"), "22023", "request_attempt_conflict");
      expect(await outbox(application)).toHaveLength(2);
    });
    const columns = (await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns where table_schema = 'public' and table_name = 'order_outbox'
    `)).rows;
    expect(columns.map(({ column_name }) => column_name).sort()).toEqual([
      "created_at", "enquiry_id", "id", "message_key", "order_id", "state", "trade_application_id", "trial_request_id", "updated_at",
    ]);
  });

  test("requires verified delivery and two units on the shared stock ledger before dispatch or purchase linkage", async () => {
    const warehouse = await user("warehouse");
    const catalogue = await user("catalogue");
    const trialId = randomUUID();
    const declinedId = randomUUID();
    const first = await variant(2, warehouse.id);
    const second = await variant(1, warehouse.id);
    const orderVariant = await variant(4, warehouse.id);

    await trial(declinedId);
    await rejects(async () => {
      await db.query(`
        insert into public.trial_fulfilments (
          trial_request_id, state, recipient_name, address_line1, address_town, address_postcode,
          address_country, address_verified_at, address_verified_by, carrier, carrier_service, dispatched_at,
          dispatched_by, tracking_number
        ) values ($1, 'dispatched', 'Test Buyer', '1 Print Lane', 'London', 'SW1A 1AA',
          'GB', now(), $2, 'Carrier', 'Standard', now(), $2, 'TRACK')
      `, [declinedId, warehouse.id]);
      await db.query("set constraints all immediate");
    }, "23514", "two_trial_units_required");

    await asRole("service_role", async () => {
      await trial(trialId);
      await rejects(() => rpc("dispatch_trial_fulfilment", [trialId, warehouse.id, "TRACK"]),
        "P0002");
      await rejects(() => approve(trialId, catalogue.id, [first, second]), "42501", "warehouse_role_required");
      await rejects(() => approve(trialId, warehouse.id, [first]), "22023", "two_trial_units_required");
      await rejects(() => approve(trialId, warehouse.id, [first, second], delivery, false),
        "22023", "verified_delivery_address_and_service_required");
      await rejects(() => approve(trialId, warehouse.id, [first, second], delivery, true, ""),
        "22023", "verified_delivery_address_and_service_required");
      await rejects(() => approve(trialId, warehouse.id, [first, second], { ...delivery, line1: "" }), "23514");
      await rejects(() => approve(trialId, warehouse.id, [first, second], { ...delivery, postcode: "ZZ99 9ZZ" }), "23514");
      await rejects(() => approve(trialId, warehouse.id, [first, second], { ...delivery, country: "NL" }), "23514");
      const earlyOrder = await order(second);
      await pay(earlyOrder.id);
      await rejects(() => approve(trialId, warehouse.id, [first, second]), "P0001", "insufficient_stock");
      expect(await stock(first)).toEqual({ stock_on_hand: 2, stock_reserved: 0 });
      await rpc("cancel_order", [earlyOrder.id, randomUUID(), warehouse.id]);
      expect(await approve(trialId, warehouse.id, [first, second])).toBe(trialId);
      expect(await approve(trialId, warehouse.id, [second, first])).toBe(trialId);
      await rejects(() => approve(trialId, warehouse.id, [first, first]), "22023", "trial_already_approved");
      expect(await stock(first)).toEqual({ stock_on_hand: 2, stock_reserved: 1 });
      expect(await stock(second)).toEqual({ stock_on_hand: 1, stock_reserved: 1 });
      await rejects(() => order(second), "P0001", "insufficient_stock");
      await rejects(() => rpc("link_trial_order", [trialId, earlyOrder.id, warehouse.id]), "22023",
        "trial_order_link_not_available");
      await rejects(() => rpc("dispatch_trial_fulfilment", [trialId, warehouse.id, " "]), "22023",
        "trial_tracking_required");
      expect(await rpc("dispatch_trial_fulfilment", [trialId, warehouse.id, "TRACK"])).toBe(trialId);
      expect(await rpc("dispatch_trial_fulfilment", [trialId, warehouse.id, "TRACK"])).toBe(trialId);
      await rejects(() => rpc("dispatch_trial_fulfilment", [trialId, warehouse.id, "CHANGED"]), "22023",
        "trial_not_allocated");
      await rejects(() => rpc("cancel_trial_fulfilment", [trialId, warehouse.id]), "22023", "trial_not_allocated");
      expect(await stock(first)).toEqual({ stock_on_hand: 1, stock_reserved: 0 });
      expect(await stock(second)).toEqual({ stock_on_hand: 0, stock_reserved: 0 });
      await rejects(() => rpc("link_trial_order", [trialId, earlyOrder.id, warehouse.id]), "22023",
        "not_a_subsequent_purchase");
      const purchase = await order(orderVariant, contactEmail);
      const wrongBuyer = await order(orderVariant, "someone-else@example.test");
      await rejects(() => rpc("link_trial_order", [trialId, purchase.id, warehouse.id]), "22023",
        "not_a_subsequent_purchase");
      await db.query("reset role");
      await db.query("update public.orders set created_at = clock_timestamp() where id in ($1, $2)",
        [purchase.id, wrongBuyer.id]);
      await db.query("set local role service_role");
      await pay(purchase.id);
      await pay(wrongBuyer.id);
      await rejects(() => rpc("link_trial_order", [trialId, wrongBuyer.id, warehouse.id]), "22023",
        "not_a_subsequent_purchase");
      expect(await rpc("link_trial_order", [trialId, purchase.id, warehouse.id])).toBe(trialId);
      expect(await rpc("link_trial_order", [trialId, purchase.id, warehouse.id])).toBe(trialId);
      const { rows } = await db.query(`
        select kind, on_hand_delta, reserved_delta, order_id from public.stock_movements
        where trial_request_id = $1 order by id
      `, [trialId]);
      expect(rows).toEqual([
        ...Array.from({ length: 2 }, () => ({ kind: "reserve", on_hand_delta: 0, reserved_delta: 1, order_id: null })),
        ...Array.from({ length: 2 }, () => ({ kind: "dispatch", on_hand_delta: -1, reserved_delta: -1, order_id: null })),
      ]);
      const orderConfirmation = await one("select message_key, enquiry_id from public.order_outbox where order_id = $1",
        [purchase.id]);
      expect(orderConfirmation).toEqual({ message_key: "order_confirmation", enquiry_id: null });
    });
    await asRole("authenticated", async () => {
      expect((await db.query("update public.trial_requests set status = 'declined' where id = $1", [declinedId])).rowCount)
        .toBe(1);
      expect((await db.query("select trial_request_id from public.trial_fulfilments where trial_request_id = $1",
        [trialId])).rows).toEqual([]);
      expect((await db.query("select variant_id from public.trial_allocations where trial_request_id = $1",
        [trialId])).rowCount).toBe(2);
      await rejects(() => approve(declinedId, warehouse.id, [first, second]), "42501");
    }, catalogue.id);
    await asRole("authenticated", async () => {
      expect(await one("select state, tracking_number, carrier_service from public.trial_fulfilments where trial_request_id = $1",
        [trialId])).toEqual({ state: "dispatched", tracking_number: "TRACK", carrier_service: "Standard" });
      await rejects(() => db.query("update public.trial_fulfilments set tracking_number = 'CHANGED'"), "42501");
    }, warehouse.id);
  });

  test("retention clears old unconverted PII and its outbox while preserving stock history, approved records and live windows", async () => {
    const warehouse = await user("warehouse");
    const finance = await user("finance");
    const buyer = await user();
    const otherBuyer = await user();
    const oldEnquiry = randomUUID();
    const keptEnquiry = randomUUID();
    const activeEnquiry = randomUUID();
    const oldTrial = randomUUID();
    const keptTrial = randomUUID();
    const oldTrade = randomUUID();
    const keptTrade = randomUUID();
    const item = await variant(2, warehouse.id);
    const expiredIp = hex();
    const expiredEmail = hex();
    const activeIp = hex();
    const activeEmail = hex();
    const { oldSearch, liveSearch } = await asRole("service_role", async () => {
      await enquiry(oldEnquiry);
      await enquiry(keptEnquiry);
      await enquiry(activeEnquiry);
      await trial(oldTrial);
      await trial(keptTrial);
      await trade(oldTrade, buyer.id);
      await trade(keptTrade, otherBuyer.id);
      await approve(keptTrial, warehouse.id, [item, item]);
      expect(await rpc("cancel_trial_fulfilment", [keptTrial, warehouse.id])).toBe(keptTrial);
      expect(await rpc("cancel_trial_fulfilment", [keptTrial, warehouse.id])).toBe(keptTrial);
      expect(await stock(item)).toEqual({ stock_on_hand: 2, stock_reserved: 0 });
      await rpc("review_trade_application", [keptTrade, finance.id, "approved"]);
      const oldSearch = await rpc("record_finder_search", ["unmatched", null, hex()]);
      const liveSearch = await rpc("record_finder_search", ["exact", "EDGZ10"]);
      const redacted = await rpc("record_finder_search", ["unmatched"]);
      expect(await one("select normalised_query, query_fingerprint from public.finder_search_events where id = $1",
        [redacted])).toEqual({ normalised_query: null, query_fingerprint: null });
      await rejects(() => rpc("record_finder_search", ["exact", "EDGZ10", hex()]), "23514");
      await rejects(() => rpc("record_finder_search", ["suggested", "private@example.test"]), "23514");
      await rejects(() => rpc("record_finder_search", ["unmatched", null, "not-a-fingerprint"]), "23514");
      await rejects(() => rpc("consume_request_rate_limit", ["trial", "a raw address", hex()]),
        "22023", "invalid_request_rate_limit_input");
      await rpc("consume_request_rate_limit", ["trial", expiredIp, expiredEmail]);
      await rpc("consume_request_rate_limit", ["trial", activeIp, activeEmail]);
      await db.query("update public.order_outbox set state = 'failed' where enquiry_id = $1", [oldEnquiry]);
      return { oldSearch, liveSearch };
    });
    await db.query("update public.enquiries set created_at = now() - interval '60 days' where id = any($1::uuid[])",
      [[oldEnquiry, keptEnquiry, activeEnquiry]]);
    await db.query("update public.trial_requests set created_at = now() - interval '60 days' where id in ($1, $2)",
      [oldTrial, keptTrial]);
    await db.query("update public.trade_applications set created_at = now() - interval '60 days' where id in ($1, $2)",
      [oldTrade, keptTrade]);
    await db.query("update public.finder_search_events set created_at = now() - interval '60 days' where id = $1", [oldSearch]);
    await db.query("update private.request_rate_limits set expires_at = now() - interval '1 hour' where key in ($1, $2)",
      [expiredIp, expiredEmail]);
    await asRole("authenticated", async () => {
      await db.query("update public.enquiries set status = 'converted' where id = $1", [keptEnquiry]);
      await db.query("update public.enquiries set status = 'in_review' where id = $1", [activeEnquiry]);
    }, warehouse.id);
    await asRole("service_role", async () => {
      await rejects(() => rpc("purge_request_data", ["0 days", "1 day", "1 day", "1 day"]),
        "22023", "invalid_request_retention_period");
      expect(await rpc("purge_request_data", ["1 day", "1 day", "1 day", "1 day"])).toEqual({
        enquiries: 1, trials: 1, trade_applications: 1, finder_search_events: 1, rate_limit_windows: 2,
      });
      for (const id of [oldEnquiry, oldTrial, oldTrade]) expect(await outbox(id)).toEqual([]);
      for (const id of [keptEnquiry, activeEnquiry, keptTrial, keptTrade]) expect(await outbox(id)).toHaveLength(2);
      expect((await db.query("select id from public.finder_search_events where id in ($1, $2)",
        [oldSearch, liveSearch])).rows).toEqual([{ id: liveSearch }]);
      expect((await db.query("select kind from public.stock_movements where trial_request_id = $1 order by id",
        [keptTrial])).rows).toEqual([{ kind: "reserve" }, { kind: "release" }]);
    });
    expect((await db.query("select attempts from private.request_rate_limits where key in ($1, $2, $3, $4)",
      [expiredIp, expiredEmail, activeIp, activeEmail])).rows).toEqual([{ attempts: 1 }, { attempts: 1 }]);
  });
});

test("serializes a real two-session limiter race and independently caps both dimensions", async () => {
  const clients = await Promise.all(Array.from({ length: 6 }, () => connect()));
  const first = clients[0]!;
  const second = clients[1]!;
  const ip = hex();
  const email = hex();
  const waitingIp = hex();
  const cappedKey = hex();
  const emails = Array.from({ length: 12 }, hex);
  const ips = Array.from({ length: 4 }, hex);
  const keys = [ip, email, waitingIp, cappedKey, ...emails, ...ips];
  const consume = (client: Client, ipKey: string, emailKey: string) =>
    rpc<boolean>("consume_request_rate_limit", ["enquiry", ipKey, emailKey], client);
  try {
    await Promise.all(clients.map((client) => client.query("set role service_role")));
    expect(await consume(first, ip, email)).toBe(true);
    expect(await consume(first, ip, email)).toBe(true);
    await first.query("begin");
    expect(await consume(first, ip, email)).toBe(true);
    const pid = await one<{ id: number }>("select pg_backend_pid() as id", [], second);
    const waiting = consume(second, waitingIp, email);
    try {
      await expect.poll(async () =>
        (await one<{ blocked: boolean }>("select cardinality(pg_blocking_pids($1)) > 0 as blocked", [pid.id])).blocked,
      ).toBe(true);
    } finally {
      await first.query("commit");
    }
    expect(await waiting).toBe(false);
    expect((await db.query("select key, attempts from private.request_rate_limits where key in ($1, $2)",
      [email, waitingIp])).rows).toEqual([{ key: email, attempts: 3 }]);

    const ipResults = await Promise.all(emails.map((newEmail, i) => consume(clients[i % clients.length]!, cappedKey, newEmail)));
    expect(ipResults.filter(Boolean)).toHaveLength(10);
    const emailResults = await Promise.all(ips.map((newIp, i) => consume(clients[i]!, newIp, cappedKey)));
    expect(emailResults.filter(Boolean)).toHaveLength(3);
    expect((await db.query("select dimension, attempts from private.request_rate_limits where key = $1 order by dimension",
      [cappedKey])).rows).toEqual([{ dimension: "email", attempts: 3 }, { dimension: "ip", attempts: 10 }]);
    await db.query("update private.request_rate_limits set expires_at = clock_timestamp() - interval '1 second' where key = $1",
      [cappedKey]);
    await first.query("begin");
    await second.query("begin");
    try {
      expect(await consume(first, cappedKey, cappedKey)).toBe(true);
      const stats = await rpc("purge_request_data", ["100 years", "100 years", "100 years", "100 years"], second);
      expect(stats).toHaveProperty("rate_limit_windows");
    } finally {
      await second.query("rollback");
      await first.query("commit");
    }
    expect((await db.query("select dimension, attempts from private.request_rate_limits where key = $1 order by dimension",
      [cappedKey])).rows).toEqual([{ dimension: "email", attempts: 1 }, { dimension: "ip", attempts: 1 }]);
  } finally {
    await Promise.all(clients.map((client) => client.end()));
    await db.query("delete from private.request_rate_limits where key = any($1)", [keys]);
  }
});
