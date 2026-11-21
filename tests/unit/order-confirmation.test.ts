import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { GET } from "@/app/api/cron/order-confirmations/route";
import { GET as getRequestEmails } from "@/app/api/cron/request-emails/route";
import { hostedStripeInvoice, renderConfirmation } from "@/lib/email/confirmation";
import { processOrderConfirmations, processRequestEmails } from "@/lib/email/outbox";
import { fileProvider, resendProvider } from "@/lib/email/provider";
import { requestFollowUp, requestReceipt } from "@/lib/email/request-email";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/outbox", () => ({ processOrderConfirmations: vi.fn(), processRequestEmails: vi.fn(), replayOrderConfirmation: vi.fn() }));
vi.mock("@/lib/admin/replay", () => ({ drainFinanceRetries: vi.fn(async () => ({ claimed: 0, retryLater: 0 })) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

const order = {
  id: "8fbd7d5d-17d3-45ec-b005-eba7dd5da0bd",
  order_reference: "EDG-00000042",
  email: "buyer@example.test",
  recipient_name: 'A <script> & "B"',
  goods_net_pence: 4_200,
  delivery_net_pence: 695,
  vat_rate_bps: 2_000,
  vat_pence: 979,
  gross_pence: 5_874,
  payment_method: "card" as const,
  po_number: null,
  delivery_service: "Standard & tracking",
  promised_dispatch_date: "2026-11-23",
  estimated_delivery_date: "2026-11-24",
};
const items = [{ sku: "EDGE-1", option_label: "Tool < 40 mm", quantity: 2, unit_price_pence: 2_100, net_pence: 4_200 }];

test("renders the order snapshot in text and safe HTML, including VAT, dates and Stripe invoice", () => {
  const result = renderConfirmation(order, items, "orders@example.test", "https://invoice.stripe.com/i/test?a=1&b=2");
  expect(result.to).toEqual(["buyer@example.test"]);
  expect(result.subject).toBe(`Edgey order confirmation: ${order.order_reference}`);
  expect(result.text).toContain(`Your order reference is ${order.order_reference}.`);
  expect(result.html).toContain(`Your order reference is ${order.order_reference}.`);
  expect(JSON.stringify(result)).not.toContain(order.id);
  expect(result.text).toContain("EDGE-1 — Tool < 40 mm: 2 × £21.00 = £42.00 ex VAT");
  expect(result.text).toContain("Goods subtotal (ex VAT): £42.00");
  expect(result.text).toContain("Delivery (ex VAT): £6.95");
  expect(result.text).toContain("VAT (20%): £9.79");
  expect(result.text).toContain("Total paid (inc VAT): £58.74");
  expect(result.text).toContain("Promised dispatch: Monday, 23 November 2026");
  expect(result.text).toContain("Estimated delivery: Tuesday, 24 November 2026");
  expect(result.text).toContain("View your VAT invoice: https://invoice.stripe.com/i/test?a=1&b=2");
  expect(result.html).toContain('href="https://invoice.stripe.com/i/test?a=1&amp;b=2"');
  expect(result.html).toContain("A &lt;script&gt; &amp; &quot;B&quot;");
  expect(result.html).toContain("Tool &lt; 40 mm");
  expect(result.html).not.toContain("<script>");
});

test("tells trade buyers the order is on account rather than paid", () => {
  const result = renderConfirmation({ ...order, payment_method: "net30", po_number: "PO <42>" }, items, "orders@example.test", null);
  expect(result.text).toContain("Order total (inc VAT): £58.74");
  expect(result.text).toContain("Payment terms: Net 30");
  expect(result.html).toContain("PO &lt;42&gt;");
  expect(result.text).not.toContain("Total paid");
});

test("rejects unsafe recipients and omits missing or unsafe invoice links", () => {
  for (const link of [
    null, "http://invoice.stripe.com/i/test", "https://invoice.stripe.com.evil.test/i/test",
    "https://invoice.stripe.com@evil.test/i/test", "https://user:pw@invoice.stripe.com/i/test",
    "javascript:alert(1)",
  ]) {
    expect(hostedStripeInvoice(link)).toBeNull();
    expect(renderConfirmation(order, items, "orders@example.test", link).html).not.toContain("<a ");
  }
  expect(() => renderConfirmation(
    { ...order, email: "buyer@example.test,other@example.test" }, items, "orders@example.test", null,
  )).toThrow("Cannot render");
});

test("sends the exact body and stable idempotency key to Resend over HTTPS", async () => {
  const send = vi.fn().mockResolvedValue(Response.json({ id: "provider-id" }));
  vi.stubGlobal("fetch", send);
  const body = '{"text": "same bytes"}';
  await expect(resendProvider("unit-test-key").send("order-confirmation/test", body))
    .resolves.toEqual({ status: "sent", id: "provider-id" });
  expect(send).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
    method: "POST",
    headers: {
      Authorization: "Bearer unit-test-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "order-confirmation/test",
    },
    body,
    redirect: "error",
    signal: expect.any(AbortSignal),
  }));
});

test.each([
  [429, { name: "rate_limit_exceeded" }, "provider_rate_limited"],
  [409, { name: "concurrent_idempotent_requests" }, "provider_uncertain"],
  [409, { name: "invalid_idempotent_request" }, "provider_conflict"],
  [422, { name: "validation_error" }, "provider_rejected"],
  [503, {}, "provider_uncertain"],
  [200, { id: null }, "provider_uncertain"],
] as const)("classifies Resend response %s / %j as %s", async (status, body, outcome) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));
  await expect(resendProvider("unit-test-key").send("order-confirmation/test", "{}")).resolves.toEqual({ status: outcome });
});

test("treats a lost Resend response as an ambiguous delivery", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection lost")));
  await expect(resendProvider("unit-test-key").send("order-confirmation/test", "{}"))
    .resolves.toEqual({ status: "provider_uncertain" });
});

test("publishes a single complete file for concurrent sends without overwriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "edgey-test-email-"));
  try {
    const provider = fileProvider(directory);
    const body = '{"text":"one receipt"}';
    const key = "order-confirmation/test";
    const results = await Promise.all(Array.from({ length: 8 }, () => provider.send(key, body)));
    expect(results).toEqual(results.map(() => ({ status: "sent", id: expect.any(String) })));
    if (results[0]?.status !== "sent") throw new Error("No local confirmation file was written.");
    const name = `${results[0].id}.json`;
    expect(await readdir(directory)).toEqual([name]);
    expect(await provider.send(key, '{"text":"different receipt"}')).toEqual({ status: "provider_conflict" });
    expect(await readFile(join(directory, name), "utf8")).toBe(body);
    expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires server cron authentication before processing the outbox", async () => {
  vi.stubEnv("CRON_SECRET", "test-cron");
  const url = "https://example.test/api/cron/order-confirmations";
  expect((await GET(new Request(url))).status).toBe(401);
  expect((await GET(new Request(url, { headers: { authorization: "Bearer wrong-cron" } }))).status).toBe(401);
  expect(processOrderConfirmations).not.toHaveBeenCalled();
  vi.stubEnv("EMAIL_PROVIDER", undefined);
  vi.stubEnv("RESEND_API_KEY", undefined);
  const authorised = () => new Request(url, { headers: { authorization: "Bearer test-cron" } });
  const unconfigured = await GET(authorised());
  expect(unconfigured.status).toBe(503);
  expect(await unconfigured.json()).toEqual({ error: "RESEND_API_KEY is not configured." });
  expect(processOrderConfirmations).not.toHaveBeenCalled();
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("EMAIL_FROM", "Edgey <orders@example.test>");
  vi.mocked(processOrderConfirmations).mockResolvedValue({ sent: 1, failed: 2, pending: 0 });
  const response = await GET(authorised());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sent: 1, failed: 2, pending: 0, finance: { claimed: 0, retryLater: 0 } });
});

test("keeps order cron runnable when the separately protected request cron is not configured", async () => {
  vi.stubEnv("CRON_SECRET", "test-cron");
  vi.stubEnv("EMAIL_PROVIDER", "resend");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("EMAIL_FROM", "Edgey <orders@example.test>");
  vi.stubEnv("EDGEY_REQUEST_HASH_KEY", undefined);
  vi.stubEnv("REQUEST_STAFF_EMAIL", "staff@example.test,other@example.test");
  const url = "https://example.test/api/cron/request-emails";
  const headers = { authorization: "Bearer test-cron" };
  const request = () => new Request(url, { headers });
  expect((await getRequestEmails(new Request(url))).status).toBe(401);
  expect((await getRequestEmails(request())).status).toBe(503);

  vi.stubEnv("EDGEY_REQUEST_HASH_KEY", "test-only-request-key-with-thirty-two-bytes");
  expect(await (await getRequestEmails(request())).json()).toEqual({
    error: "REQUEST_STAFF_EMAIL must be one valid email address.",
  });
  expect(processRequestEmails).not.toHaveBeenCalled();
  vi.mocked(processOrderConfirmations).mockResolvedValue({ sent: 1, failed: 0, pending: 0 });
  expect((await GET(new Request("https://example.test/api/cron/order-confirmations", { headers }))).status).toBe(200);

  vi.stubEnv("REQUEST_STAFF_EMAIL", "staff@example.test");
  vi.mocked(processRequestEmails).mockResolvedValue({ sent: 1, failed: 0, pending: 0 });
  expect(await (await getRequestEmails(request())).json()).toEqual({ sent: 1, failed: 0, pending: 0 });
  expect(processRequestEmails).toHaveBeenCalledOnce();
});

test("receipt fingerprints are insensitive to mailbox casing and neutral copy contains no request details", () => {
  vi.stubEnv("EDGEY_REQUEST_HASH_KEY", "test-only-request-key-with-thirty-two-bytes");
  const first = requestReceipt("from@example.test", "Buyer@Example.Test")!;
  const second = requestReceipt("from@example.test", "buyer@example.test")!;
  expect(first.recipientFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(first.recipientFingerprint).toBe(second.recipientFingerprint);
  expect(first.recipientFingerprint).not.toBe(requestReceipt("from@example.test", "other@example.test")!.recipientFingerprint);
  expect(JSON.parse(first.payload)).toMatchObject({
    to: ["Buyer@Example.Test"],
    subject: "Edgey received a request",
    text: "We received a request submitted using this email address.\n\nIf you didn’t make the request, you can ignore this email.",
  });
  expect(first.payload).not.toContain(first.recipientFingerprint);
  expect(requestReceipt("from@example.test", "buyer@example.test,other@example.test")).toBeNull();
});

test("request follow-ups preserve plain text and reject invalid recipient or header values", () => {
  const text = '<a href="javascript:alert(1)">Example</a>\nNew line & quotation.';
  const from = "from@example.test";
  const to = "buyer@example.test";
  const subject = "Your Edgey enquiry";
  expect(JSON.parse(requestFollowUp(from, ` ${to} `, subject, text)!)).toEqual({ from, to: [to], subject, text });
  expect(requestFollowUp(from, `${to},other@example.test`, subject, text)).toBeNull();
  expect(requestFollowUp(from, to, "subject\r\nBcc: other@example.test", text)).toBeNull();
  expect(requestFollowUp(from, to, null, text)).toBeNull();
  expect(requestFollowUp(from, to, subject, " \n ")).toBeNull();
});
