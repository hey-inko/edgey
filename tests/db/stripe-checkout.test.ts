import { randomUUID } from "node:crypto";
import { Client } from "pg";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { POST as openCheckout } from "@/app/api/checkout/session/route";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { quoteCurrentSelection } from "@/lib/checkout/server";
import { reconcileStripePayments, replayStripeEvent } from "@/lib/payments/reconciliation";
import { readCheckoutSuccess } from "@/lib/payments/success";

const provider = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), session: vi.fn(), intent: vi.fn(), invoice: vi.fn(), refund: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: provider.create, list: provider.list, retrieve: provider.session } },
    paymentIntents: { retrieve: provider.intent },
    invoices: { retrieve: provider.invoice },
    refunds: { retrieve: provider.refund },
    webhooks: signer.webhooks,
  }),
}));

const signer = new Stripe("sk_test_fixture");
const webhookSecret = "whsec_fixture";
const origin = "http://127.0.0.1:3000";
const paymentDate = "2026-11-20T15:29:00.000Z";
const fields = {
  email: "buyer@example.test", businessName: "Sample Print", recipientName: "Example Buyer", buyingForWork: true,
  line1: "1 Sample Street", town: "London", postcode: "SW1A 1AA", country: "US",
};
let db: Client;
const variants: string[] = [];
const events: string[] = [];
const attempts: string[] = [];
const sessions = new Map<string, Stripe.Checkout.Session>();
const sessionsByKey = new Map<string, Stripe.Checkout.Session>();
const id = (prefix: string) => prefix + randomUUID().replaceAll("-", "");

beforeAll(async () => {
  const connectionString = process.env.SUPABASE_DB_URL;
  const api = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!connectionString || !api || ![connectionString, api].every((url) =>
    ["localhost", "127.0.0.1"].includes(new URL(url).hostname))) {
    throw new Error("These tests need local Supabase. Run pnpm db:start && pnpm db:env.");
  }
  db = new Client({ connectionString, statement_timeout: 5_000 });
  await db.connect();
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", webhookSecret);
  provider.create.mockImplementation(createSession);
  provider.list.mockImplementation(async (filter: { payment_intent?: string }) => ({
    data: [...sessions.values()].filter((session) => !filter.payment_intent || session.payment_intent === filter.payment_intent),
    has_more: false,
  }));
  provider.session.mockImplementation(async (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) throw Object.assign(new Error("unknown mock session"), { statusCode: 404 });
    return session;
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  sessions.clear();
  sessionsByKey.clear();
  const ids = (await db.query<{ id: string }>(
    "select id from public.orders where checkout_attempt_token = any($1)", [attempts.splice(0)],
  )).rows.map((row) => row.id);
  for (const table of ["private.order_operations", "public.order_outbox", "public.stock_movements", "public.stock_reservations", "public.order_items"]) {
    await db.query(`delete from ${table} where order_id = any($1)`, [ids]);
  }
  await db.query("delete from public.orders where id = any($1)", [ids]);
  await db.query("delete from public.variants where id = any($1)", [variants.splice(0)]);
  await db.query("delete from public.provider_events where provider = 'stripe' and event_id = any($1)", [events.splice(0)]);
});

afterAll(() => db?.end());

function createSession(params: Stripe.Checkout.SessionCreateParams, options: { idempotencyKey: string }) {
  const old = sessionsByKey.get(options.idempotencyKey);
  if (old) return old;
  const sessionId = id("cs_test_");
  const session = {
    id: sessionId, livemode: false, mode: "payment", metadata: params.metadata, client_reference_id: params.client_reference_id,
    expires_at: params.expires_at, url: `https://checkout.stripe.com/c/pay/${sessionId}`, status: "open", payment_status: "unpaid",
    currency: "gbp", amount_total: params.line_items?.reduce((sum, line) =>
      sum + (line.quantity ?? 0) * (line.price_data?.unit_amount ?? 0), 0),
  } as Stripe.Checkout.Session;
  sessions.set(sessionId, session);
  sessionsByKey.set(options.idempotencyKey, session);
  return session;
}

async function makeVariant(stock: number) {
  const variantId = randomUUID();
  await db.query(`
    insert into public.variants (id, product_id, sku, supplier_part_number, price_1_4_pence, price_5_9_pence,
      price_10_plus_pence, stock_on_hand, publication_status, approved_at, evidence_source)
    select $1, id, $2, 'TEST', 2250, 1995, 1750, $3, 'published', now(), 'Stripe test'
    from public.products where family_code = 'EDG-Z10'
  `, [variantId, "STRIPE-" + variantId, stock]);
  variants.push(variantId);
  return variantId;
}

async function checkoutInput(variantId: string, quantity: number) {
  const lines = [{ variantId, quantity, unitPricePence: 1 }];
  const quote = await quoteCurrentSelection(lines, fields.postcode);
  if (quote.status !== "ok" || !quote.basket) throw new Error("Checkout fixture could not be priced.");
  const attemptToken = randomUUID();
  attempts.push(attemptToken);
  return { lines, attemptToken, fields, quoteKey: quote.quoteKey, totals: { grossPence: 1 }, buyerId: randomUUID() };
}

function submit(input: Awaited<ReturnType<typeof checkoutInput>>) {
  return openCheckout(new Request(origin + "/api/checkout/session", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(input),
  }));
}

async function checkout(variantId: string, quantity: number) {
  const input = await checkoutInput(variantId, quantity);
  const response = await submit(input);
  const data = await response.json();
  expect(data).toMatchObject({ status: "payment", sessionId: expect.any(String) });
  expect(response.status).toBe(200);
  return { input, session: sessions.get(data.sessionId)! };
}

function paid(session: Stripe.Checkout.Session, amount = session.amount_total!, currency = "gbp") {
  const intentId = id("pi_");
  session.status = "complete";
  session.payment_status = "paid";
  session.payment_intent = intentId;
  provider.intent.mockResolvedValue({
    id: intentId, livemode: false, metadata: session.metadata, status: "succeeded", amount_received: amount, currency,
    latest_charge: {
      id: id("ch_"), paid: true, captured: true, livemode: false, payment_intent: intentId,
      amount_captured: amount, currency, created: Date.parse(paymentDate) / 1000,
    },
  });
  return intentId;
}

function event(type: string, objectId: string) {
  const eventId = id("evt_");
  events.push(eventId);
  const body = JSON.stringify({
    id: eventId, object: "event", livemode: false, type,
    data: { object: { id: objectId, client_secret: "unpersisted-test-client-secret", email: "hidden@example.test" } },
  });
  const signature = signer.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret });
  return {
    eventId,
    deliver(payload = body) {
      return stripeWebhook(new Request(origin + "/api/webhooks/stripe", {
        method: "POST", body: payload, headers: { "Stripe-Signature": signature },
      }));
    },
  };
}

async function state(orderId: string) {
  const { rows } = await db.query(`
    select o.*, r.state as reservation_state,
      (select count(*)::integer from public.order_outbox q where q.order_id = o.id) as confirmations
    from public.orders o join public.stock_reservations r on r.order_id = o.id where o.id = $1
  `, [orderId]);
  return rows[0];
}

async function eventState(eventId: string) {
  return (await db.query("select state, last_error, payload from public.provider_events where event_id = $1", [eventId])).rows[0];
}

it("creates one order and session on replay after its last stock is held, with the exact saved charge", async () => {
  const { input, session } = await checkout(await makeVariant(5), 5);
  const response = await submit(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "payment", sessionId: session.id, url: session.url });
  expect(provider.create).toHaveBeenCalledTimes(1);
  expect(provider.create.mock.calls[0]?.[1]).toEqual({ idempotencyKey: `edgey:checkout:v1:${session.client_reference_id}` });
  const order = await state(session.client_reference_id!);
  expect(order).toMatchObject({ gross_pence: 12804, vat_pence: 2134, address_country: "GB", buyer_id: null, reservation_state: "held" });
  expect(session.amount_total).toBe(12804);
  expect(order.hold_expires_at.getTime()).toBe(session.expires_at * 1000);
  const changed = await submit({ ...input, fields: { ...fields, line1: "2 Sample Street" } });
  expect(changed.status).toBe(409);
  expect(sessions.size).toBe(1);
});

it("recovers a timed-out create by discovering the same provider session before retrying", async () => {
  provider.create.mockImplementationOnce(async (params, options) => {
    createSession(params, options);
    throw new Error("response timed out after Stripe accepted");
  });
  const { input, session } = await checkout(await makeVariant(1), 1);
  expect((await (await submit(input)).json()).sessionId).toBe(session.id);
  expect(provider.create).toHaveBeenCalledTimes(1);
  expect(sessions.size).toBe(1);
});

it("admits only one payable checkout for concurrent buyers competing for the last unit", async () => {
  const variantId = await makeVariant(1);
  const [first, second] = await Promise.all([checkoutInput(variantId, 1), checkoutInput(variantId, 1)]);
  const responses = await Promise.all([submit(first), submit(second)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(sessions.size).toBe(1);
});

it("uses raw signature bytes and never persists unverified event data", async () => {
  const invalid = event("checkout.session.completed", id("cs_test_"));
  expect((await invalid.deliver(" ")).status).toBe(400);
  expect(await eventState(invalid.eventId)).toBeUndefined();
  const unknown = event("customer.updated", id("cus_"));
  expect((await unknown.deliver()).status).toBe(200);
  expect(await eventState(unknown.eventId)).toEqual({
    state: "processed", last_error: null, payload: { objectId: expect.stringMatching(/^cus_/) },
  });
});

it("applies refund, invoice and crossed checkout events once and keeps success reads side-effect free", async () => {
  const { session } = await checkout(await makeVariant(5), 5);
  const orderId = session.client_reference_id!;
  expect(await readCheckoutSuccess(session.id)).toEqual({ kind: "pending" });
  const intentId = paid(session);
  const refundId = id("re_");
  const invoiceId = id("in_");
  provider.refund.mockResolvedValue({ id: refundId, status: "succeeded", payment_intent: intentId, amount: 300, currency: "gbp" });
  provider.invoice.mockResolvedValue({ id: invoiceId, livemode: false, metadata: session.metadata });
  const invoice = event("invoice.finalized", invoiceId);
  expect((await invoice.deliver()).status).toBe(200);
  expect(await eventState(invoice.eventId)).toMatchObject({ state: "failed" });
  const refund = event("refund.created", refundId);
  const expiry = event("checkout.session.expired", session.id);
  await Promise.all([refund.deliver(), refund.deliver(), expiry.deliver()]);
  session.invoice = invoiceId;
  expect(await replayStripeEvent(invoice.eventId)).toBe("processed");
  expect(await replayStripeEvent(invoice.eventId)).toBe("not_replayable");
  const completed = event("checkout.session.completed", session.id);
  expect((await completed.deliver()).status).toBe(200);
  const order = await state(orderId);
  expect(order).toMatchObject({
    fulfilment_status: "ready_to_pick", payment_status: "partially_refunded", reservation_state: "allocated",
    confirmations: 1, paid_pence: 12804, refunded_pence: 300, provider_invoice_id: invoiceId,
    authorised_at: new Date(paymentDate), promised_dispatch_date: new Date("2026-11-20"), estimated_delivery_date: new Date("2026-11-23"),
  });
  expect(await readCheckoutSuccess(orderId)).toBeNull();
  expect(await readCheckoutSuccess(id("cs_test_"))).toBeNull();
  const snapshot = await readCheckoutSuccess(session.id);
  expect(snapshot).toMatchObject({ kind: "confirmed", grossPence: 12804, lines: [{ quantity: 5 }] });
  expect(snapshot).not.toHaveProperty("email");
  expect(await readCheckoutSuccess(session.id)).toEqual(snapshot);
  expect(await state(orderId)).toEqual(order);
});

it("leaves an amount or currency mismatch held for staff rather than picking or emailing", async () => {
  const { session } = await checkout(await makeVariant(1), 1);
  paid(session, 1234, "usd");
  const completed = event("checkout.session.completed", session.id);
  expect((await completed.deliver()).status).toBe(200);
  expect(await eventState(completed.eventId)).toMatchObject({ state: "failed", last_error: expect.stringMatching(/amount or currency/) });
  expect(await state(session.client_reference_id!)).toMatchObject({
    fulfilment_status: "awaiting_authorisation", reservation_state: "held", confirmations: 0,
    payment_review_reason: "payment_amount_or_currency_mismatch",
  });
  expect(await readCheckoutSuccess(session.id)).toEqual({ kind: "review" });
});

it("does not release on the local clock or an expired event until Stripe confirms closure", async () => {
  const { session } = await checkout(await makeVariant(1), 1);
  const orderId = session.client_reference_id!;
  session.expires_at = Math.floor(Date.now() / 1000) - 15;
  await db.query("update public.orders set hold_expires_at = to_timestamp($2) where id = $1", [orderId, session.expires_at]);
  const expiry = event("checkout.session.expired", session.id);
  expect((await expiry.deliver()).status).toBe(200);
  await reconcileStripePayments();
  expect(await state(orderId)).toMatchObject({
    reservation_state: "held", stripe_reconciliation_error: expect.stringMatching(/has not confirmed/),
  });
  session.status = "expired";
  await db.query("update public.orders set stripe_replay_after = '1970-01-01' where id = $1", [orderId]);
  await reconcileStripePayments();
  expect(await state(orderId)).toMatchObject({
    reservation_state: "released", fulfilment_status: "cancelled", confirmations: 0, stripe_reconciliation_error: null,
  });
  paid(session);
  const capturedLate = event("checkout.session.async_payment_succeeded", session.id);
  expect((await capturedLate.deliver()).status).toBe(200);
  expect(await state(orderId)).toMatchObject({
    reservation_state: "released", fulfilment_status: "cancelled", confirmations: 0,
    payment_review_reason: "payment_after_reservation_released",
  });
});
