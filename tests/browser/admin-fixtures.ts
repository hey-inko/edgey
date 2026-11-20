import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { localAdminClient } from "../../scripts/seed-admin";

export async function signInStaff(page: Page, credentials: { email: string; password: string }) {
  await page.goto("/admin");
  await page.getByLabel("Work email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Staff desk" })).toBeVisible();
}

export async function seedPaidAdminOrder() {
  const db = localAdminClient();
  const { data: variant, error: variantError } = await db.from("variants")
    .select("id,sku,price_1_4_pence")
    .eq("sku", "EDG-Z10").single();
  if (variantError || !variant.price_1_4_pence) throw new Error("Apply the local staging fixture first.");
  const quantity = 2;
  const goods = variant.price_1_4_pence * quantity;
  const delivery = 695;
  const vat = Math.round(goods / 5) + Math.round(delivery / 5);
  const gross = goods + delivery + vat;
  const recipient = "Alex Test";
  const service = "Next working day";
  const dispatchDate = "2026-11-24";
  const deliveryDate = "2026-11-25";
  const created = await db.rpc("create_order_with_reservations", {
    p_attempt_token: randomUUID(),
    p_lines: [{ variant_id: variant.id, quantity, unit_price_pence: variant.price_1_4_pence }],
    p_contact: { email: "warehouse-fixture@example.test", business_name: "Fixture Print Works",
      recipient_name: recipient, buying_for_work: true },
    p_address: { line1: "1 Fixture Lane", town: "London", postcode: "SW1A 1AA", country: "GB" },
    p_totals: { goods_net_pence: goods, delivery_net_pence: delivery, vat_rate_bps: 2000,
      vat_pence: vat, gross_pence: gross },
    p_hold_expires_at: new Date(Date.now() + 40 * 60_000).toISOString(),
    p_delivery_service: service,
    p_dispatch_date: dispatchDate,
    p_delivery_date: deliveryDate,
  });
  if (created.error) throw created.error;
  const captured = await db.rpc("confirm_payment", {
    p_order_id: created.data.id, p_session_id: `cs_test_${randomUUID()}`, p_payment_intent_id: `pi_${randomUUID()}`,
    p_amount_pence: gross, p_currency: "gbp", p_paid_at: new Date().toISOString(),
    p_dispatch_date: dispatchDate, p_delivery_date: deliveryDate,
  });
  if (captured.error) throw captured.error;
  expect(captured.data.fulfilment_status).toBe("ready_to_pick");
  return { id: created.data.id, variant, quantity, recipient, service };
}
