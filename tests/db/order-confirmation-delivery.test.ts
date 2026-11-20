import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { replayOrderConfirmation } from "@/lib/email/outbox";

const { retrieveInvoice } = vi.hoisted(() => ({ retrieveInvoice: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => ({ invoices: { retrieve: retrieveInvoice } }) }));

type Row = {
  order_id: string;
  state: "pending" | "failed" | "sent";
  attempt_count: number;
  lease_token: string | null;
  send_started_at: Date | null;
  send_payload: string | null;
  send_provider: string | null;
  send_in_flight: boolean;
  last_error: string | null;
  next_attempt_at: Date;
  delivery_uncertain: boolean;
  provider_message_id: string | null;
  sent_at: Date | null;
};

let connectionString: string;
let db: Client;
const fixtures: string[] = [];

async function connect() {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3_000, statement_timeout: 5_000 });
  await client.connect();
  return client;
}

beforeAll(async () => {
  const local = process.env.SUPABASE_DB_URL;
  const api = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!local || !api || ![local, api].every((url) => ["localhost", "127.0.0.1"].includes(new URL(url).hostname))) {
    throw new Error("These tests need local Supabase. Run pnpm db:start && pnpm db:env.");
  }
  connectionString = local;
  db = await connect();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  retrieveInvoice.mockReset();
  const ids = fixtures.splice(0);
  if (ids.length) {
    await db.query("delete from public.order_outbox where order_id = any($1)", [ids]);
    await db.query("delete from public.order_items where order_id = any($1)", [ids]);
    await db.query("delete from public.orders where id = any($1)", [ids]);
  }
});

afterAll(() => db?.end());

async function fixture(state: "failed" | "pending" = "pending", invoiceId: string | null = null) {
  const id = randomUUID();
  fixtures.push(id);
  await db.query(`
    insert into public.orders (
      id, checkout_attempt_token, email, recipient_name, business_name, buying_for_work,
      address_line1, address_town, address_postcode, address_country, goods_net_pence,
      delivery_net_pence, vat_rate_bps, vat_pence, gross_pence, paid_pence, payment_status,
      fulfilment_status, authorised_at, hold_expires_at, delivery_service, promised_dispatch_date,
      estimated_delivery_date, provider_invoice_id
    ) values (
      $1, $2, 'test@example.test', 'A Test Buyer', 'Delivery Test', true, '1 Test Street',
      'London', 'SW1A 1AA', 'GB', 1000, 100, 2000, 220, 1320, 1320, 'paid', 'ready_to_pick',
      now(), now() + interval '32 minutes', 'Standard', '2026-11-23', '2026-11-24', $3
    )
  `, [id, randomUUID(), invoiceId]);
  await db.query("select public.enqueue_order_confirmation($1)", [id]);
  await db.query("update public.order_outbox set state = $2, next_attempt_at = '1970-01-01' where order_id = $1", [id, state]);
  return id;
}

const claim = (client: Client, orderId?: string) =>
  client.query<Row>("select * from public.claim_order_confirmation($1)", [orderId ?? null]).then(({ rows }) => rows);

const begin = (row: Row, payload?: string) => db.query<Row>(
  "select * from public.begin_order_confirmation_send($1, $2, $3, $4)",
  [row.order_id, row.lease_token, payload === undefined ? null : "resend", payload ?? null],
).then(({ rows }) => rows);

const finish = (row: Row, outcome: string, providerId?: string) => db.query<Row>(
  "select * from public.finish_order_confirmation($1, $2, $3, $4)",
  [row.order_id, row.lease_token, outcome, providerId ?? null],
).then(({ rows }) => rows);

const readOutbox = (id: string) => db.query<Row>(
  "select * from public.order_outbox where order_id = $1", [id],
).then(({ rows }) => rows[0]!);

const initialPayload = '{"sender":"original", "order": "unchanged"}';

test.each(["pending", "failed"] as const)("two independent service workers cannot claim the same %s row", async (state) => {
  const id = await fixture(state);
  const workers = await Promise.all([connect(), connect()]);
  try {
    await Promise.all(workers.map((worker) => worker.query("begin; set local role service_role")));
    const results = await Promise.all(workers.map((worker) => claim(worker, state === "failed" ? id : undefined)));
    const winners = results.flat().filter((row) => row.order_id === id);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.lease_token).toEqual(expect.any(String));
  } finally {
    await Promise.all(workers.map(async (worker) => {
      await worker.query("rollback");
      await worker.end();
    }));
  }
});

test("reclaims an expired lease with the same payload and fences the original worker", async () => {
  const id = await fixture();
  const [first] = (await claim(db)).filter((row) => row.order_id === id);
  expect(first).toBeDefined();
  const [attempt] = await begin(first!, initialPayload);
  expect(attempt).toMatchObject({ send_payload: initialPayload, send_in_flight: true, attempt_count: 1 });
  expect(await begin(first!)).toEqual([]);
  await db.query(`
    update public.order_outbox set lease_until = now() - interval '1 second',
      next_attempt_at = '1970-01-01' where order_id = $1
  `, [id]);
  const [second] = (await claim(db)).filter((row) => row.order_id === id);
  expect(second).toMatchObject({ send_payload: initialPayload, delivery_uncertain: true, send_in_flight: false });
  expect(second!.lease_token).not.toBe(first!.lease_token);
  expect(await finish(first!, "sent", "late")).toEqual([]);
  await expect(begin(second!, '{"different":true}')).rejects.toMatchObject({ message: "order_confirmation_payload_frozen" });
  const [retry] = await begin(second!);
  expect(retry).toMatchObject({ send_payload: initialPayload, attempt_count: 2, send_started_at: attempt!.send_started_at });
  expect((await finish(second!, "sent", "same-provider-message"))[0]).toMatchObject({
    state: "sent", delivery_uncertain: false, last_error: null, sent_at: expect.any(Date),
    provider_message_id: "same-provider-message", lease_token: null,
  });
  expect(await claim(db, id)).toEqual([]);
  await db.query("select public.enqueue_order_confirmation($1)", [id]);
  expect(await readOutbox(id)).toMatchObject({ state: "sent", attempt_count: 2 });
});

test("backs off ambiguous outcomes and refuses automatic or manual retry at the deduplication cutoff", async () => {
  const id = await fixture();
  const [first] = (await claim(db)).filter((row) => row.order_id === id);
  expect(first).toBeDefined();
  await begin(first!, initialPayload);
  const [after] = await finish(first!, "provider_uncertain");
  expect(after).toMatchObject({ state: "pending", last_error: "provider_uncertain", delivery_uncertain: true });
  expect(after!.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 55_000);
  expect(await claim(db, id)).toEqual([]);
  await db.query(`
    update public.order_outbox set send_started_at = now() - interval '23 hours 56 minutes',
      next_attempt_at = '1970-01-01' where order_id = $1
  `, [id]);
  const ended = (await claim(db)).find((row) => row.order_id === id);
  expect(ended).toMatchObject({
    state: "failed", last_error: "delivery_unconfirmed", delivery_uncertain: true, lease_token: null, attempt_count: 1,
  });
  expect(await replayOrderConfirmation(id)).toBe("not_replayable");
});

test("invalidates a claimed retry that reaches the cutoff before begin-send", async () => {
  const id = await fixture("failed");
  const [first] = await claim(db, id);
  await begin(first!, initialPayload);
  await finish(first!, "provider_rejected");
  const [second] = await claim(db, id);
  await db.query("update public.order_outbox set send_started_at = now() - interval '24 hours' where order_id = $1", [id]);
  expect(await begin(second!)).toEqual([]);
  await db.query(`
    update public.order_outbox set lease_until = now() - interval '1 second',
      next_attempt_at = '1970-01-01' where order_id = $1
  `, [id]);
  expect((await claim(db)).find((row) => row.order_id === id)).toMatchObject({
    state: "failed", last_error: "retry_window_expired", delivery_uncertain: false, attempt_count: 1,
  });
});

test("stops on an idempotency conflict and preserves the ambiguity of a previous attempt", async () => {
  const id = await fixture("failed");
  await db.query("update public.order_outbox set delivery_uncertain = true where order_id = $1", [id]);
  const [initial] = await claim(db, id);
  await begin(initial!, initialPayload);
  expect((await finish(initial!, "provider_rejected"))[0]).toMatchObject({
    state: "failed", delivery_uncertain: true,
  });
  const [retry] = await claim(db, id);
  await begin(retry!);
  expect((await finish(retry!, "provider_conflict"))[0]).toMatchObject({
    state: "failed", last_error: "delivery_unconfirmed", delivery_uncertain: true,
  });
  expect(await claim(db, id)).toEqual([]);
});

test("keeps delivery RPCs and sensitive outbox data service-only", async () => {
  const { rows } = await db.query<{ role: string; claim: boolean; begin: boolean; finish: boolean; payload: boolean; metadata: boolean }>(`
    select role,
      has_function_privilege(role, 'public.claim_order_confirmation(uuid)', 'execute') as claim,
      has_function_privilege(role, 'public.begin_order_confirmation_send(uuid,uuid,text,text)', 'execute') as begin,
      has_function_privilege(role, 'public.finish_order_confirmation(uuid,uuid,text,text)', 'execute') as finish,
      has_column_privilege(role, 'public.order_outbox', 'send_payload', 'select') as payload,
      has_column_privilege(role, 'public.order_outbox', 'last_error', 'select') as metadata
    from unnest(array['anon', 'authenticated', 'service_role']) as role
  `);
  expect(rows).toEqual([
    { role: "anon", claim: false, begin: false, finish: false, payload: false, metadata: false },
    { role: "authenticated", claim: false, begin: false, finish: false, payload: false, metadata: true },
    { role: "service_role", claim: true, begin: true, finish: true, payload: true, metadata: true },
  ]);
});

test("gives a recently authorised order time to pick up its invoice without freezing a body", async () => {
  const id = await fixture("failed");
  vi.stubEnv("EMAIL_PROVIDER", "resend");
  vi.stubEnv("EMAIL_FROM", "orders@example.test");
  vi.stubEnv("RESEND_API_KEY", "test-mocked-resend-key");
  const provider = vi.fn();
  const request = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "https://api.resend.com/emails" ? provider(input, init) : request(input, init),
  );

  expect(await replayOrderConfirmation(id)).toBe("pending");
  const row = await readOutbox(id);
  expect(row).toMatchObject({ state: "pending", attempt_count: 0, send_started_at: null, send_payload: null });
  expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 55_000);
  expect(retrieveInvoice).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
});

test("freezes the first Stripe invoice and Resend body across actual PostgREST calls and staff replay", async () => {
  const id = await fixture("failed", `in_${randomUUID()}`);
  await db.query(`
    insert into public.order_items (
      order_id, variant_id, sku, option_label, quantity, unit_price_pence, net_pence, tax_pence, gross_pence
    ) select $1, id, 'ORIGINAL-SKU', 'Original option', 1, 1000, 1000, 200, 1200
      from public.variants limit 1
  `, [id]);
  vi.stubEnv("EMAIL_PROVIDER", "resend");
  vi.stubEnv("EMAIL_FROM", "orders@example.test");
  vi.stubEnv("RESEND_API_KEY", "test-mocked-resend-key");
  retrieveInvoice.mockResolvedValue({ hosted_invoice_url: "https://invoice.stripe.com/i/test-1" });
  const provider = vi.fn()
    .mockImplementationOnce(() => Response.json({ name: "validation_error" }, { status: 422 }))
    .mockImplementationOnce(() => Response.json({ id: "resend-message-id" }));
  const request = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "https://api.resend.com/emails" ? provider(input, init) : request(input, init),
  );

  expect(await replayOrderConfirmation(id)).toBe("failed");
  const first = await readOutbox(id);
  expect(first).toMatchObject({ state: "failed", attempt_count: 1, send_provider: "resend", last_error: "provider_rejected" });
  expect(JSON.parse(first.send_payload!).text).toContain("https://invoice.stripe.com/i/test-1");
  expect(JSON.parse(first.send_payload!).from).toBe("orders@example.test");
  vi.stubEnv("EMAIL_FROM", "changed@example.test");
  retrieveInvoice.mockResolvedValue({ hosted_invoice_url: "https://invoice.stripe.com/i/changed" });
  await db.query("update public.order_items set option_label = 'Changed option' where order_id = $1", [id]);
  expect(await replayOrderConfirmation(id)).toBe("sent");
  expect(await replayOrderConfirmation(id)).toBe("not_replayable");
  expect(retrieveInvoice).toHaveBeenCalledTimes(1);
  expect(provider).toHaveBeenCalledTimes(2);
  for (const [, init] of provider.mock.calls) {
    expect(init.headers["Idempotency-Key"]).toBe(`order-confirmation/${id}`);
    expect(init.body).toBe(first.send_payload);
  }
  expect(await readOutbox(id)).toMatchObject({
    state: "sent", attempt_count: 2, provider_message_id: "resend-message-id", send_payload: first.send_payload,
  });
});
