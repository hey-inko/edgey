import { randomUUID } from "node:crypto";
import { Client } from "pg";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { drainFinanceRetries, requestFinanceReplay } from "@/lib/admin/replay";
import { POST as openCheckout } from "@/app/api/checkout/session/route";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { getBuyerSession } from "@/lib/auth/server";
import { quoteCurrentSelection } from "@/lib/checkout/server";
import { recordProviderEvent } from "@/lib/orders";
import { reconcileStripePayments, replayStripeEvent } from "@/lib/payments/reconciliation";
import { readCheckoutSuccess } from "@/lib/payments/success";
import { createLocalAdminUser } from "../../scripts/seed-admin";

const provider = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), session: vi.fn(), intent: vi.fn(), invoice: vi.fn(), refund: vi.fn(), expire: vi.fn(), account: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/server", () => ({ getBuyerSession: vi.fn() }));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    accounts: { retrieveCurrent: provider.account },
    checkout: { sessions: { create: provider.create, list: provider.list, retrieve: provider.session, expire: provider.expire } },
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
const buyerIds: string[] = [];
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
  vi.mocked(getBuyerSession).mockResolvedValue({ status: "guest" });
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", webhookSecret);
  vi.stubEnv("EDGEY_REQUEST_HASH_KEY", randomUUID() + randomUUID());
  provider.account.mockResolvedValue({ id: "acct_testFixture" });
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
  provider.expire.mockImplementation(async (sessionId: string) => {
    const session = sessions.get(sessionId)!;
    session.status = "expired";
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
  await db.query("delete from auth.users where id = any($1)", [buyerIds.splice(0)]);
  await db.query("delete from public.variants where id = any($1)", [variants.splice(0)]);
  await db.query("delete from public.provider_events where provider = 'stripe' and event_id = any($1)", [events.splice(0)]);
  await db.query("delete from private.closed_checkout_attempts");
  await db.query("delete from private.payment_rate_limits where scope in ('checkout', 'checkout_close')");
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

async function makeBuyer(email = `${randomUUID()}@example.test`) {
  const id = randomUUID();
  await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [id, email]);
  buyerIds.push(id);
  return { status: "verified" as const, buyer: { id, email } };
}

async function checkoutInput(variantId: string, quantity: number) {
  const lines = [{ variantId, quantity, unitPricePence: 1 }];
  const quote = await quoteCurrentSelection(lines, fields.postcode);
  if (quote.status !== "ok" || !quote.basket) throw new Error("Checkout fixture could not be priced.");
  const attemptToken = randomUUID();
  attempts.push(attemptToken);
  return { lines, attemptToken, fields, quoteKey: quote.quoteKey, totals: { grossPence: 1 }, buyerId: randomUUID() };
}

function submit(input: unknown) {
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

function event(type: string, objectId: string, livemode = false) {
  const eventId = id("evt_");
  events.push(eventId);
  const body = JSON.stringify({
    id: eventId, object: "event", livemode, type,
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

it("attaches a card order only to the verified buyer and lets that buyer replay, resume and close it", async () => {
  const actor = await makeBuyer();
  vi.mocked(getBuyerSession).mockResolvedValue(actor);
  const { input, session } = await checkout(await makeVariant(1), 1);
  expect(getBuyerSession).toHaveBeenCalledOnce();
  expect(await state(session.client_reference_id!)).toMatchObject({
    buyer_id: actor.buyer.id, email: fields.email, reservation_state: "held",
  });
  const payment = { status: "payment", sessionId: session.id, url: session.url };
  expect(await (await submit(input)).json()).toEqual(payment);
  expect(await (await submit({ action: "resume", attemptToken: input.attemptToken })).json()).toEqual(payment);
  const changed = await submit({ ...input, lines: [{ ...input.lines[0], quantity: 2 }] });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ message: expect.stringContaining("changed order"), attemptPending: true });
  expect(await (await submit({ action: "close", attemptToken: input.attemptToken })).json()).toEqual({ status: "closed" });
  expect(await state(session.client_reference_id!)).toMatchObject({
    buyer_id: actor.buyer.id, fulfilment_status: "cancelled", reservation_state: "released",
  });
  expect(provider.create).toHaveBeenCalledTimes(1);
  expect(provider.expire).toHaveBeenCalledExactlyOnceWith(session.id);
});

it("keeps a guest attempt guest-bound even when the signed-in buyer has the order's email", async () => {
  const { input, session } = await checkout(await makeVariant(1), 1);
  vi.mocked(getBuyerSession).mockResolvedValue(await makeBuyer(fields.email));
  for (const action of [undefined, "resume", "close"]) {
    const response = await submit({ ...input, action });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "error", attemptOwnerMismatch: true, attemptPending: true });
  }
  expect(provider.session).not.toHaveBeenCalled();
  expect(provider.expire).not.toHaveBeenCalled();
  expect(await state(session.client_reference_id!)).toMatchObject({ buyer_id: null, reservation_state: "held" });

  vi.mocked(getBuyerSession).mockResolvedValue({ status: "guest" });
  expect(await (await submit({ action: "resume", attemptToken: input.attemptToken })).json()).toMatchObject({
    status: "payment", sessionId: session.id,
  });
  expect(await (await submit({ action: "close", attemptToken: input.attemptToken })).json()).toEqual({ status: "closed" });
});

it("cannot reopen, close, or supersede another buyer’s card attempt as a guest or different buyer", async () => {
  const actor = await makeBuyer();
  vi.mocked(getBuyerSession).mockResolvedValue(actor);
  const variantId = await makeVariant(2);
  const replacement = await checkoutInput(variantId, 1);
  const { input, session } = await checkout(variantId, 1);
  for (const wrongActor of [{ status: "guest" } as const, await makeBuyer()]) {
    vi.mocked(getBuyerSession).mockResolvedValue(wrongActor);
    for (const action of [undefined, "resume", "close"]) {
      for (const request of [input, { ...replacement, supersedesAttemptToken: input.attemptToken }]) {
        const response = await submit({ ...request, action, buyerId: actor.buyer.id });
        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body).toMatchObject({ status: "error", attemptOwnerMismatch: true, attemptPending: true });
        expect(body).not.toHaveProperty("sessionId");
        expect(body).not.toHaveProperty("url");
      }
    }
  }
  const orders = await db.query("select buyer_id from public.orders where checkout_attempt_token = any($1)", [attempts]);
  expect(orders.rows).toEqual([{ buyer_id: actor.buyer.id }]);
  expect(provider.session).not.toHaveBeenCalled();
  expect(provider.create).toHaveBeenCalledTimes(1);
  expect(provider.expire).not.toHaveBeenCalled();
  expect(await state(session.client_reference_id!)).toMatchObject({ reservation_state: "held" });
});

it("rejects submit, resume, and close when the buyer cookie cannot be verified", async () => {
  const { input, session } = await checkout(await makeVariant(1), 1);
  vi.mocked(getBuyerSession).mockResolvedValue({ status: "unverified" });
  const newInput = await checkoutInput(await makeVariant(1), 1);
  for (const request of [newInput, input, { ...input, action: "resume" }, { ...input, action: "close" }]) {
    const response = await submit(request);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ status: "error", message: expect.stringContaining("couldn’t verify your sign-in") });
  }
  expect(provider.session).not.toHaveBeenCalled();
  expect(provider.create).toHaveBeenCalledTimes(1);
  expect(provider.expire).not.toHaveBeenCalled();
  expect(await state(session.client_reference_id!)).toMatchObject({ buyer_id: null, reservation_state: "held" });
  const order = await db.query("select id from public.orders where checkout_attempt_token = $1", [newInput.attemptToken]);
  expect(order.rowCount).toBe(0);
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

it("never redirects to an open Stripe session with a different total", async () => {
  provider.create.mockImplementationOnce((params, options) => {
    const session = createSession(params, options);
    session.amount_total = 1;
    return session;
  });
  const response = await submit(await checkoutInput(await makeVariant(1), 1));
  expect(response.status).toBe(409);
  expect(await response.json()).not.toHaveProperty("url");
  const [session] = sessions.values();
  expect(await state(session!.client_reference_id!)).toMatchObject({
    reservation_state: "held", stripe_reconciliation_error: expect.stringMatching(/amount or currency/),
  });
});

it.each(["guest", "signed-in"])("creates one reservation for two simultaneous %s requests using the same attempt", async (kind) => {
  const actor = kind === "guest" ? { status: "guest" } as const : await makeBuyer();
  vi.mocked(getBuyerSession).mockResolvedValue(actor);
  const input = await checkoutInput(await makeVariant(1), 1);
  const responses = await Promise.all([submit(input), submit(input)]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const results = await Promise.all(responses.map((response) => response.json()));
  expect(results[0]).toEqual(results[1]);
  expect(sessions.size).toBe(1);
  const orderId = sessions.get(results[0].sessionId)!.client_reference_id!;
  expect(await state(orderId)).toMatchObject({
    buyer_id: actor.status === "verified" ? actor.buyer.id : null, reservation_state: "held", confirmations: 0,
  });
});

it("allows only one actor to submit when a guest and buyer race for the same attempt", async () => {
  const actor = await makeBuyer();
  vi.mocked(getBuyerSession).mockResolvedValueOnce(actor).mockResolvedValueOnce({ status: "guest" });
  const input = await checkoutInput(await makeVariant(1), 1);
  const responses = await Promise.all([submit(input), submit(input)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const failure = responses.find((response) => response.status === 409)!;
  expect(await failure.json()).toMatchObject({ status: "error", attemptOwnerMismatch: true });
  expect(sessions.size).toBe(1);
});

it("admits only one payable checkout for concurrent buyers competing for the last unit", async () => {
  const variantId = await makeVariant(1);
  const [first, second] = await Promise.all([checkoutInput(variantId, 1), checkoutInput(variantId, 1)]);
  const responses = await Promise.all([submit(first), submit(second)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(sessions.size).toBe(1);
});

it("resumes a reserved last unit and expires it before replacing a changed checkout", async () => {
  const { input, session } = await checkout(await makeVariant(1), 1);
  const repeated = await submit({ action: "resume", attemptToken: input.attemptToken });
  expect(await repeated.json()).toMatchObject({ status: "payment", sessionId: session.id });
  const replacementToken = randomUUID();
  attempts.push(replacementToken);
  const replacement = await submit({
    ...input, attemptToken: replacementToken, supersedesAttemptToken: input.attemptToken,
    fields: { ...fields, line1: "2 Sample Street" },
  });
  expect(await replacement.json()).toMatchObject({ status: "payment", sessionId: expect.not.stringMatching(session.id) });
  expect(provider.expire).toHaveBeenCalledExactlyOnceWith(session.id);
  expect(await state(session.client_reference_id!)).toMatchObject({ fulfilment_status: "cancelled", reservation_state: "released" });
  expect(sessions.size).toBe(2);
});

it.each(["guest", "signed-in"])("cannot recreate a %s checkout stopped before its order arrived", async (kind) => {
  if (kind === "signed-in") vi.mocked(getBuyerSession).mockResolvedValue(await makeBuyer());
  const input = await checkoutInput(await makeVariant(1), 1);
  const cancelled = await submit({ action: "close", attemptToken: input.attemptToken });
  expect(await cancelled.json()).toEqual({ status: "closed" });
  const stale = await submit(input);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ attemptClosed: true });
  expect(provider.create).not.toHaveBeenCalled();
});

it("limits new reservations without blocking a saved-order retry", async () => {
  const variantId = await makeVariant(12);
  const inputs = await Promise.all(Array.from({ length: 4 }, () => checkoutInput(variantId, 1)));
  for (const input of inputs.slice(0, 3)) expect((await submit(input)).status).toBe(200);
  expect((await submit(inputs[3])).status).toBe(429);
  expect((await submit(inputs[0])).status).toBe(200);
  expect(sessions.size).toBe(3);
});

it("uses raw signature bytes and never persists unverified event data", async () => {
  const invalid = event("checkout.session.completed", id("cs_test_"));
  expect((await invalid.deliver(" ")).status).toBe(400);
  expect(await eventState(invalid.eventId)).toBeUndefined();
  const live = event("checkout.session.completed", id("cs_test_"), true);
  expect((await live.deliver()).status).toBe(400);
  expect(await eventState(live.eventId)).toBeUndefined();
  const unknown = event("customer.updated", id("cus_"));
  expect((await unknown.deliver()).status).toBe(200);
  expect(await eventState(unknown.eventId)).toEqual({
    state: "processed", last_error: null, payload: { objectId: expect.stringMatching(/^cus_/) },
  });
});

it("applies refund, invoice and crossed checkout events once and keeps success reads side-effect free", async () => {
  const { session } = await checkout(await makeVariant(5), 5);
  const orderId = session.client_reference_id!;
  expect(session.metadata?.edgey_order_id).toBe(orderId);
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
  expect(await readCheckoutSuccess(order.order_reference)).toBeNull();
  expect(await readCheckoutSuccess(id("cs_test_"))).toBeNull();
  const snapshot = await readCheckoutSuccess(session.id);
  expect(snapshot).toMatchObject({ kind: "confirmed", reference: order.order_reference, grossPence: 12804, lines: [{ quantity: 5 }] });
  expect(order.order_reference).toMatch(/^EDG-[0-9]{8}$/);
  expect(JSON.stringify(snapshot)).not.toContain(orderId);
  expect(snapshot).not.toHaveProperty("email");
  expect(await readCheckoutSuccess(session.id)).toEqual(snapshot);
  expect(await state(orderId)).toEqual(order);
});

it("reconciles a durably received event after interruption without the original request", async () => {
  const { session } = await checkout(await makeVariant(1), 1);
  const orderId = session.client_reference_id!;
  paid(session);
  const { eventId } = event("checkout.session.completed", session.id);
  await recordProviderEvent({
    provider: "stripe", eventId, eventType: "checkout.session.completed", payload: { objectId: session.id },
  });
  expect(await readCheckoutSuccess(session.id)).toEqual({ kind: "pending" });
  expect(await state(orderId)).toMatchObject({ reservation_state: "held", confirmations: 0 });
  await db.query("update public.provider_events set stripe_replay_after = '1970-01-01' where event_id = $1", [eventId]);
  expect(await reconcileStripePayments()).toMatchObject({ eventsChecked: 1, unresolvedEvents: 0 });
  expect(await eventState(eventId)).toMatchObject({ state: "processed" });
  expect(await state(orderId)).toMatchObject({ reservation_state: "allocated", confirmations: 1 });
});

it("finds a paid pending order well before expiry when Stripe never delivers its webhook", async () => {
  const { session } = await checkout(await makeVariant(1), 1);
  const orderId = session.client_reference_id!;
  paid(session);
  await db.query(`update public.orders set created_at = now() - interval '3 minutes',
    stripe_replay_after = '1970-01-01' where id = $1`, [orderId]);
  const result = await reconcileStripePayments();
  expect(result).toMatchObject({ eventsChecked: 0, ordersChecked: 1, unresolvedOrders: 0 });
  expect(await state(orderId)).toMatchObject({ reservation_state: "allocated", confirmations: 1 });
  expect(await readCheckoutSuccess(session.id)).toMatchObject({ kind: "confirmed" });
});

it("finance replays only the currently requested failed version, and only one worker claims it", async () => {
  const { session } = await checkout(await makeVariant(1), 1);
  const invoiceId = id("in_");
  const orderId = session.client_reference_id!;
  paid(session);
  provider.invoice.mockResolvedValue({ id: invoiceId, metadata: session.metadata, livemode: false });
  const invoice = event("invoice.finalized", invoiceId);
  const { eventId } = invoice;
  await invoice.deliver();
  expect(await eventState(eventId)).toMatchObject({ state: "failed" });
  const other = new Client({ connectionString: process.env.SUPABASE_DB_URL, statement_timeout: 5_000 });
  const finance = await createLocalAdminUser("finance");
  await other.connect();
  try {
    await other.query("begin");
    await other.query("select target_id from public.finance_retry_requests where kind = 'event' for update");
    expect(await requestFinanceReplay(finance.id, { kind: "event", id: eventId })).toBe(true);
    await db.query("update public.provider_events set last_error = 'Fixture newer failure' where event_id = $1", [eventId]);
    expect(await drainFinanceRetries("event", replayStripeEvent)).toMatchObject({ claimed: 0 });
    expect(await replayStripeEvent(eventId)).toBe("failed");
    expect(await requestFinanceReplay(finance.id, { kind: "event", id: eventId })).toBe(true);
    expect(await replayStripeEvent(eventId)).toBe("failed");
    session.invoice = invoiceId;
    const results = await Promise.all([
      drainFinanceRetries("event", replayStripeEvent),
      drainFinanceRetries("event", replayStripeEvent),
    ]);
    expect(results.map((row) => row.claimed).sort()).toEqual([0, 1]);
    expect(await state(orderId)).toMatchObject({ provider_invoice_id: invoiceId, confirmations: 1 });
    expect(await eventState(eventId)).toMatchObject({ state: "processed" });
  } finally {
    await other.end();
    await db.query("delete from public.finance_retry_requests where target_id = $1", [eventId]);
    await db.query("delete from auth.users where id = $1", [finance.id]);
  }
});

it("holds ambiguous creation until a complete search of the original sandbox proves it safe to release", async () => {
  const input = await checkoutInput(await makeVariant(1), 1);
  provider.create.mockRejectedValueOnce(new Error("provider timeout"));
  expect((await submit(input)).status).toBe(502);
  const { rows: [order] } = await db.query<{ id: string }>(`
    update public.orders set hold_expires_at = date_trunc('second', now()) - interval '1 minute',
      created_at = now() - interval '36 minutes', stripe_replay_after = '1970-01-01'
      where checkout_attempt_token = $1 returning id
  `, [input.attemptToken]);
  expect(await reconcileStripePayments()).toMatchObject({ unresolvedOrders: 1 });
  expect(await state(order!.id)).toMatchObject({
    reservation_state: "held", stripe_reconciliation_error: expect.stringMatching(/could not verify/i),
  });
  expect((await submit(input)).status).toBe(409);
  expect(provider.create).toHaveBeenCalledTimes(1);
  await db.query(`update public.orders set hold_expires_at = now() - interval '3 minutes',
    stripe_replay_after = '1970-01-01' where id = $1`, [order!.id]);
  provider.account.mockResolvedValue({ id: "acct_wrongSandbox" });
  expect(await reconcileStripePayments()).toMatchObject({ unresolvedOrders: 1 });
  expect(await state(order!.id)).toMatchObject({
    reservation_state: "held", stripe_reconciliation_error: expect.stringMatching(/sandbox differs/),
  });
  await db.query("update public.orders set stripe_replay_after = '1970-01-01' where id = $1", [order!.id]);
  provider.account.mockResolvedValue({ id: "acct_testFixture" });
  expect(await reconcileStripePayments()).toMatchObject({ unresolvedOrders: 0 });
  expect(await state(order!.id)).toMatchObject({ reservation_state: "released", fulfilment_status: "cancelled" });
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
  await db.query(`update public.orders set hold_expires_at = to_timestamp($2),
    created_at = now() - interval '36 minutes' where id = $1`, [orderId, session.expires_at]);
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
