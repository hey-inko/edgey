import { expect, it, vi } from "vitest";
import { checkCron } from "@/lib/payments/cron";
import { stripeSessionParams } from "@/lib/payments/session-params";

vi.mock("server-only", () => ({}));

const order = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", order_reference: "EDG-00000042",
  email: "buyer@example.test", recipient_name: "Test Buyer",
  phone: null, address_line1: "1 Sample Street", address_line2: null, address_town: "London",
  address_region: null, address_postcode: "SW1A 1AA", address_country: "GB",
  hold_expires_at: "2026-11-23T13:00:00Z", delivery_service: "Next working day", vat_rate_bps: 2000,
};

it.each([
  [1, 2250, 450, 695, 589, 3534],
  [4, 9000, 1800, 695, 1939, 11634],
  [5, 9975, 1995, 695, 2134, 12804],
  [9, 17955, 3591, 0, 3591, 21546],
  [10, 17500, 3500, 0, 3500, 21000],
])("uses the saved gross for %i Z10s and charges tax only once", (quantity, net, tax, delivery, vat, gross) => {
  const params = stripeSessionParams({
    ...order, goods_net_pence: net, delivery_net_pence: delivery, vat_pence: vat, gross_pence: gross,
  }, [{ sku: "EDG-Z10", option_label: "Drag", quantity, net_pence: net, tax_pence: tax, gross_pence: net + tax }],
  "https://edgey.example.test");
  expect(params.line_items?.reduce((sum, line) => sum + (line.price_data?.unit_amount ?? 0) * (line.quantity ?? 0), 0)).toBe(gross);
  expect(params).toMatchObject({
    automatic_tax: { enabled: false }, adaptive_pricing: { enabled: false },
    allowed_payment_method_types: ["card"], expires_at: Date.parse(order.hold_expires_at) / 1000,
    invoice_creation: { enabled: true, invoice_data: { metadata: { edgey_order_id: order.id } } },
    payment_intent_data: { shipping: { name: order.recipient_name, address: { line1: order.address_line1, postal_code: "SW1A 1AA" } } },
    client_reference_id: order.id, metadata: { edgey_order_id: order.id },
  });
  expect(params.shipping_address_collection).toBeUndefined();
  expect(params.line_items?.every((line) => !line.tax_rates)).toBe(true);
  expect(params.invoice_creation?.invoice_data?.footer).toContain(`Edgey order ${order.order_reference}`);
  if (quantity === 5) expect(params.invoice_creation?.invoice_data?.footer)
    .toContain("VAT (20%): £21.34\nTotal including VAT: £128.04");
});

it("keeps line-level rounding even when recomputing VAT on the order would add a penny", () => {
  const item = { sku: "TEST", option_label: "Variant", quantity: 2, net_pence: 1002, tax_pence: 200, gross_pence: 1202 };
  const input = { ...order, goods_net_pence: 2004, delivery_net_pence: 0, vat_pence: 400, gross_pence: 2404 };
  const lines = [item, { ...item, sku: "OTHER" }];
  expect(stripeSessionParams(input, lines, "https://edgey.example.test").line_items)
    .toEqual([expect.objectContaining({ quantity: 1, price_data: expect.objectContaining({ unit_amount: 1202 }) }),
      expect.objectContaining({ quantity: 1, price_data: expect.objectContaining({ unit_amount: 1202 }) })]);
  expect(() => stripeSessionParams({ ...input, gross_pence: 2405 }, lines, "https://edgey.example.test"))
    .toThrow("do not match the saved order");
});

it("requires Vercel's bearer secret on cron requests and diagnoses missing configuration", () => {
  try {
    const request = (authorization: string) => new Request("https://edgey.example.test/api/cron/stripe-reconciliation", {
      headers: { authorization },
    });
    vi.stubEnv("CRON_SECRET", "");
    expect(checkCron(request("Bearer sample"))?.status).toBe(503);
    vi.stubEnv("CRON_SECRET", "sample");
    expect(checkCron(request("Bearer sample"))?.status).toBe(503);
    const cron = "a".repeat(32);
    vi.stubEnv("CRON_SECRET", cron);
    expect(checkCron(request("Bearer wrong!"))?.status).toBe(401);
    expect(checkCron(request(`Bearer ${"b".repeat(32)}`))?.status).toBe(401);
    expect(checkCron(request(`Bearer ${cron}`))).toBeNull();
  } finally {
    vi.unstubAllEnvs();
  }
});
