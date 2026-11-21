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
import { refundCancelledCardOrder } from "@/lib/payments/card-refund";
import { reconcileStripePayments, replayStripeEvent } from "@/lib/payments/reconciliation";
import { readCheckoutSuccess } from "@/lib/payments/success";
import { requestFingerprint } from "@/lib/requests/rate-limit";
import { createLocalAdminUser } from "../../scripts/seed-admin";
import { withExhaustedQuoteBudget } from "../helpers/quote-budget";

const provider = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), session: vi.fn(), intent: vi.fn(), invoice: vi.fn(), refund: vi.fn(), expire: vi.fn(), account: vi.fn(),
  refundCreate: vi.fn(), refundList: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/server", () => ({ getBuyerSession: vi.fn() }));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    accounts: { retrieveCurrent: provider.account },
    checkout: { sessions: { create: provider.create, list: provider.list, retrieve: provider.session, expire: provider.expire } },
    paymentIntents: { retrieve: provider.intent },
    invoices: { retrieve: provider.invoice },
    refunds: { retrieve: provider.refund, list: provider.refundList, create: provider.refundCreate },
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
  provider.refundList.mockResolvedValue({ data: [], has_more: false });
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
  await db.query("delete from private.payment_rate_limits where scope in ('checkout', 'checkout_close', 'checkout_review')");
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

it("requires a same-origin signal on authenticated card checkout before opening payment", async () => {
  const buyer = await createLocalAdminUser("buyer");
  buyerIds.push(buyer.id);
  vi.mocked(getBuyerSession).mockResolvedValue({ status: "verified", buyer });
  const input = await checkoutInput(await makeVariant(1), 1);
  const response = await openCheckout(new Request(origin + "/api/checkout/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }));
  expect(response.status).toBe(403);
  expect(provider.create).not.toHaveBeenCalled();
});

async function checkout(variantId: string, quantity: number) {
  const input = await checkoutInput(variantId, quantity);
  const response = await submit(input);
  const data = await response.json();
  expect(data).toMatchObject({ status: "payment", sessionId: expect.any(String) });
  expect(response.status).toBe(200);
  return { input, session: sessions.get(data.sessionId)! };
}

it("does not apply the public quote quota to a current card checkout", async () => {
  const input = await checkoutInput(await makeVariant(1), 1);
  await withExhaustedQuoteBudget(db, requestFingerprint("ip", "local"), async () => {
    const response = await submit(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "payment" });
  });
});

function paid(session: Stripe.Checkout.Session, amount = session.amount_total!, currency = "gbp") {
  const intentId = id("pi_");
  session.status = "complete";
  session.payment_status = "paid";
  session.payment_intent = intentId;
  provider.intent.mockResolvedValue({
    id: intentId, livemode: false, metadata: session.metadata, status: "succeeded", amount_received: amount, currency,
    latest_charge: {
      id: id("ch_"), paid: true, captured: true, livemode: false, payment_intent: intentId,
      amount_captured: amount, amount_refunded: 0, currency, created: Date.parse(paymentDate) / 1000,
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

it("recovers only existing guest payments with an unverifiable cookie and never starts or retires a missing attempt", async () => {
  const { input, session } = await checkout(await makeVariant(1), 1);
  const buyer = await makeBuyer();
  vi.mocked(getBuyerSession).mockResolvedValue(buyer);
  const signedIn = await checkout(await makeVariant(1), 1);
  vi.mocked(getBuyerSession).mockResolvedValue({ status: "unverified" });
  const newInput = await checkoutInput(await makeVariant(1), 1);
  for (const request of [newInput, input, { ...signedIn.input, action: "resume" },
    { ...signedIn.input, action: "close" }, { ...newInput, action: "close" }]) {
    const response = await submit(request);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ status: "error", message: expect.stringContaining("couldn’t verify your sign-in") });
  }
  expect(provider.session).not.toHaveBeenCalled();
  expect(provider.create).toHaveBeenCalledTimes(2);
  expect(provider.expire).not.toHaveBeenCalled();
  expect((await (await submit({ ...input, action: "resume" })).json())).toMatchObject({ sessionId: session.id });
  expect((await (await submit({ ...input, action: "close" })).json())).toEqual({ status: "closed" });
  expect(await state(session.client_reference_id!)).toMatchObject({ buyer_id: null, reservation_state: "released" });
  expect(await state(signedIn.session.client_reference_id!)).toMatchObject({ buyer_id: buyer.buyer.id, reservation_state: "held" });
  const order = await db.query("select id from public.orders where checkout_attempt_token = $1", [newInput.attemptToken]);
  expect(order.rowCount).toBe(0);
  expect((await db.query("select 1 from private.closed_checkout_attempts where attempt_token=$1", [newInput.attemptToken])).rowCount).toBe(0);
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
  provider.refund.mockResolvedValue({ id: refundId, status: "succeeded", payment_intent: intentId, amount: 300,
    currency: "gbp", charge: (await provider.intent()).latest_charge.id });
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
  expect(order.order_reference).toMatch(/^EDG-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{5}$/);
  expect(JSON.stringify(snapshot)).not.toContain(orderId);
  expect(snapshot).not.toHaveProperty("email");
  expect(await readCheckoutSuccess(session.id)).toEqual(snapshot);
  expect(await state(orderId)).toEqual(order);
});

it("acknowledges another refund event after finance resolved a fully refunded mismatch", async () => {
  const { session } = await checkout(await makeVariant(1), 1);
  const orderId = session.client_reference_id!;
  const intentId = paid(session, session.amount_total! - 1);
  const captured = event("checkout.session.completed", session.id);
  await captured.deliver();
  expect(await eventState(captured.eventId)).toMatchObject({ state: "failed" });
  const finance = await makeBuyer();
  await db.query("insert into public.staff_members(user_id,role) values ($1,'finance')", [finance.buyer.id]);
  const resolvedRefundId = id("re_");
  await db.query("select public.resolve_refunded_payment_review($1,$2,$3,$4)", [orderId, intentId, resolvedRefundId, finance.buyer.id]);
  const otherRefundId = id("re_");
  provider.refund.mockResolvedValue({ id: otherRefundId, status: "succeeded", payment_intent: intentId, amount: 300, currency: "gbp" });
  const later = event("refund.created", otherRefundId);
  await later.deliver();
  expect(await eventState(later.eventId)).toMatchObject({ state: "processed" });
  expect(await state(orderId)).toMatchObject({
    payment_review_refund_id: resolvedRefundId, paid_pence: 0, refunded_pence: 0,
    fulfilment_status: "cancelled", reservation_state: "released",
  });
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
  expect(await eventState(capturedLate.eventId)).toMatchObject({ state: "processed" });
  const capture = await provider.intent();
  const refundId = id("re_");
  const refund = event("refund.updated", refundId);
  const proof = { id: refundId, status: "succeeded", amount: capture.amount_received,
    payment_intent: capture.id, currency: "gbp", charge: capture.latest_charge.id };
  provider.refund.mockResolvedValue({ ...proof, charge: id("ch_") });
  await refund.deliver();
  expect(await eventState(refund.eventId)).toMatchObject({ state: "failed" });
  expect(await state(orderId)).toMatchObject({ refunded_pence: 0, payment_review_refund_id: null });
  provider.refund.mockResolvedValue(proof);
  await Promise.all([refund.deliver(), event("refund.created", refundId).deliver()]);
  expect(await state(orderId)).toMatchObject({
    reservation_state: "released", fulfilment_status: "cancelled", confirmations: 0,
    refunded_pence: capture.amount_received, payment_status: "refunded", payment_review_refund_id: refundId,
  });
  expect(await readCheckoutSuccess(session.id)).toEqual({ kind: "cancelled-refunded" });
});

it("resumes a timed-out finance refund with the same amount and provider key without another stock movement", async () => {
  const variant = await makeVariant(2);
  const { session } = await checkout(variant, 1);
  const orderId = session.client_reference_id!;
  const intentId = paid(session);
  await event("checkout.session.completed", session.id).deliver();
  const [finance, warehouse] = await Promise.all([makeBuyer(), makeBuyer()]);
  await db.query("insert into public.staff_members (user_id, role) values ($1, 'finance'), ($2, 'warehouse')",
    [finance.buyer.id, warehouse.buyer.id]);
  await expect(refundCancelledCardOrder(orderId, finance.buyer.id)).rejects.toThrow("Only cancelled");
  await db.query("select public.cancel_order($1,$2,$3)", [orderId, randomUUID(), warehouse.buyer.id]);
  await expect(refundCancelledCardOrder(orderId, warehouse.buyer.id)).rejects.toThrow("Only cancelled");

  const capture = await provider.intent();
  const chargeId = capture.latest_charge.id;
  provider.account.mockResolvedValueOnce({ id: "acct_wrongSandbox" });
  await expect(refundCancelledCardOrder(orderId, finance.buyer.id)).rejects.toThrow("sandbox differs");
  expect(provider.refundCreate).not.toHaveBeenCalled();
  provider.refundCreate.mockRejectedValueOnce(new Error("Network timeout"));
  await expect(refundCancelledCardOrder(orderId, finance.buyer.id)).rejects.toThrow("Network timeout");
  const [params, opts] = provider.refundCreate.mock.calls[0]!;
  expect(params).toMatchObject({ charge: chargeId, amount: session.amount_total, metadata: { edgey_order_id: orderId } });
  expect(opts.idempotencyKey).toMatch(/^edgey:card-refund:v1:/);
  expect(await state(orderId)).toMatchObject({ refunded_pence: 0 });

  const refundId = id("re_");
  provider.refundCreate.mockResolvedValue({ ...params, id: refundId, payment_intent: intentId, status: "succeeded", currency: "gbp" });
  expect(await refundCancelledCardOrder(orderId, finance.buyer.id)).toBe("refunded");
  expect(provider.refundCreate.mock.calls[1]).toEqual([params, opts]);
  capture.latest_charge.amount_refunded = params.amount;
  provider.refundList.mockResolvedValue({
    data: [{ ...params, id: refundId, payment_intent: intentId, status: "succeeded", currency: "gbp" }], has_more: false,
  });
  expect(await refundCancelledCardOrder(orderId, finance.buyer.id)).toBe("refunded");
  expect(provider.refundCreate).toHaveBeenCalledTimes(2);
  expect(await state(orderId)).toMatchObject({
    fulfilment_status: "cancelled", reservation_state: "released", payment_status: "refunded",
    refunded_pence: session.amount_total, confirmations: 1,
  });
  expect((await db.query("select action, count(*)::int as count from private.order_operations where order_id=$1 group by action", [orderId])).rows)
    .toEqual(expect.arrayContaining([{ action: "request_card_refund", count: 1 }, { action: "refund", count: 1 }]));
  expect((await db.query("select stock_on_hand,stock_reserved from public.variants where id=$1", [variant])).rows)
    .toEqual([{ stock_on_hand: 2, stock_reserved: 0 }]);
});

it("lets Finance verify a late capture without issuing, then deduplicates concurrent attempts to refund it", async () => {
  const variant = await makeVariant(1);
  const { session } = await checkout(variant, 1);
  const orderId = session.client_reference_id!;
  const finance = await makeBuyer();
  await db.query("insert into public.staff_members(user_id,role) values ($1,'finance')", [finance.buyer.id]);
  session.status = "expired";
  await event("checkout.session.expired", session.id).deliver();
  expect(await state(orderId)).toMatchObject({ fulfilment_status: "cancelled", reservation_state: "released" });
  const intentId = paid(session);
  await event("checkout.session.async_payment_succeeded", session.id).deliver();
  await expect(refundCancelledCardOrder(orderId, finance.buyer.id, false)).rejects.toThrow("hasn’t confirmed a full refund");
  expect(provider.refundCreate).not.toHaveBeenCalled();
  expect((await db.query("select 1 from private.order_operations where order_id=$1 and action='request_card_refund'", [orderId])).rows).toHaveLength(0);
  const { session: replacement } = await checkout(variant, 1);
  const refundId = id("re_");
  const bothAtProvider = Promise.withResolvers<void>();
  provider.refundCreate.mockImplementation(async (params) => {
    if (provider.refundCreate.mock.calls.length === 2) bothAtProvider.resolve();
    await bothAtProvider.promise;
    return { ...params, id: refundId, payment_intent: intentId, status: "succeeded", currency: "gbp" };
  });
  const results = await Promise.all([
    refundCancelledCardOrder(orderId, finance.buyer.id), refundCancelledCardOrder(orderId, finance.buyer.id),
  ]);
  expect(results).toEqual(["refunded", "refunded"]);
  const [first, second] = provider.refundCreate.mock.calls;
  expect(first?.[1].idempotencyKey).toMatch(/^edgey:card-refund:v1:/);
  expect(first).toEqual(second);
  expect(await state(orderId)).toMatchObject({
    fulfilment_status: "cancelled", reservation_state: "released", confirmations: 0,
    payment_status: "refunded", refunded_pence: session.amount_total, payment_review_refund_id: refundId,
  });
  expect(await state(replacement.client_reference_id!)).toMatchObject({ reservation_state: "held" });
});

it("verifies an external card refund without issuing and flags a later reversal without rewriting the journal", async () => {
  const variant = await makeVariant(1);
  const { session } = await checkout(variant, 1);
  const orderId = session.client_reference_id!;
  const [finance, warehouse] = await Promise.all([makeBuyer(), makeBuyer()]);
  await db.query("insert into public.staff_members (user_id, role) values ($1, 'finance'), ($2, 'warehouse')",
    [finance.buyer.id, warehouse.buyer.id]);
  const intentId = paid(session);
  await event("checkout.session.completed", session.id).deliver();
  await db.query("select public.cancel_order($1,$2,$3)", [orderId, randomUUID(), warehouse.buyer.id]);
  const capture = await provider.intent();
  const refundId = id("re_");
  const proof = { id: refundId, status: "succeeded", charge: capture.latest_charge.id,
    amount: session.amount_total, payment_intent: intentId, currency: "gbp" };
  capture.latest_charge.amount_refunded = proof.amount;
  provider.refundList.mockResolvedValue({ data: [proof], has_more: false });
  expect(await refundCancelledCardOrder(orderId, finance.buyer.id, false)).toBe("refunded");
  expect(provider.refundCreate).not.toHaveBeenCalled();
  const original = await state(orderId);
  expect(original).toMatchObject({ payment_status: "refunded", refunded_pence: proof.amount, reservation_state: "released" });

  proof.status = "failed";
  capture.latest_charge.amount_refunded = 0;
  provider.refund.mockResolvedValue(proof);
  const failed = event("refund.failed", refundId);
  await failed.deliver();
  expect(await eventState(failed.eventId)).toMatchObject({
    state: "failed", last_error: expect.stringContaining("previously reconciled Stripe refund"),
  });
  expect(await state(orderId)).toEqual(original);
  await expect(refundCancelledCardOrder(orderId, finance.buyer.id, false)).rejects.toThrow("hasn’t confirmed a full refund");
  provider.refund.mockResolvedValue({ ...proof, id: id("re_") });
  const unrelated = event("refund.failed", (await provider.refund()).id);
  await unrelated.deliver();
  expect(await eventState(unrelated.eventId)).toMatchObject({ state: "processed" });
  expect(provider.refundCreate).not.toHaveBeenCalled();
});

it("does not issue a second refund until Stripe proves the previous request failed", async () => {
  const { session } = await checkout(await makeVariant(1), 1);
  const orderId = session.client_reference_id!;
  const intentId = paid(session);
  await event("checkout.session.completed", session.id).deliver();
  const [finance, warehouse] = await Promise.all([makeBuyer(), makeBuyer()]);
  await db.query("insert into public.staff_members (user_id, role) values ($1, 'finance'), ($2, 'warehouse')",
    [finance.buyer.id, warehouse.buyer.id]);
  await db.query("select public.cancel_order($1,$2,$3)", [orderId, randomUUID(), warehouse.buyer.id]);
  const refundId = id("re_");
  provider.refundCreate.mockImplementationOnce(async (params) => ({
    ...params, id: refundId, payment_intent: intentId, status: "pending", currency: "gbp",
  }));
  expect(await refundCancelledCardOrder(orderId, finance.buyer.id)).toBe("pending");
  const [requestParams, requestOptions] = provider.refundCreate.mock.calls[0]!;
  const refund = { ...requestParams, id: refundId, payment_intent: intentId, status: "pending", currency: "gbp" };
  provider.refundList.mockResolvedValue({ data: [refund], has_more: false });
  expect(await refundCancelledCardOrder(orderId, finance.buyer.id)).toBe("pending");
  await db.query("update private.order_operations set created_at=now()-interval '24 hours' where order_id=$1 and action='request_card_refund'", [orderId]);
  provider.refundList.mockResolvedValueOnce({ data: [], has_more: false });
  await expect(refundCancelledCardOrder(orderId, finance.buyer.id)).rejects.toThrow("can’t be retried safely");
  expect(provider.refundCreate).toHaveBeenCalledOnce();
  expect(await state(orderId)).toMatchObject({ refunded_pence: 0, payment_status: "paid" });

  refund.status = "failed";
  provider.refundCreate.mockImplementationOnce(async (params) => ({
    ...params, id: id("re_"), payment_intent: intentId, status: "succeeded", currency: "gbp",
  }));
  expect(await refundCancelledCardOrder(orderId, finance.buyer.id)).toBe("refunded");
  const [retriedParams, retriedOptions] = provider.refundCreate.mock.calls[1]!;
  expect(retriedOptions.idempotencyKey).not.toBe(requestOptions.idempotencyKey);
  expect(retriedParams.amount).toBe(requestParams.amount);
  expect((await db.query("select input from private.order_operations where order_id=$1 and action='request_card_refund' order by created_at", [orderId])).rows)
    .toMatchObject([{ input: expect.any(Array) }, {
      input: [finance.buyer.id, "acct_testFixture", retriedParams.charge, retriedParams.amount,
        requestParams.metadata.edgey_refund_request_id, refundId],
    }]);
});

it("counts only successful fresh reservations toward the lower card limit and never blocks resume on that limit", async () => {
  const sku = await makeVariant(8);
  for (let i = 0; i < 4; i++) {
    const attempt = await checkoutInput(sku, 1);
    expect((await submit({ ...attempt, quoteKey: "stale-quote" })).status).toBe(409);
  }
  const [first, second, third] = await Promise.all(Array.from({ length: 3 }, () => checkoutInput(sku, 1)));
  const [original, duplicate, next, last] = await Promise.all([submit(first), submit(first), submit(second), submit(third)]);
  expect([original.status, duplicate.status, next.status, last.status]).toEqual([200, 200, 200, 200]);
  const rejected = await submit(await checkoutInput(sku, 1));
  expect(rejected.status).toBe(429);
  expect(sessionsByKey.size).toBe(3);
  expect((await submit({ attemptToken: first!.attemptToken, action: "resume" })).status).toBe(200);
  expect((await db.query("select stock_on_hand,stock_reserved from public.variants where id=$1", [sku])).rows)
    .toEqual([{ stock_on_hand: 8, stock_reserved: 3 }]);
});
