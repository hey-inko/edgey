import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createLocalAdminUser, localAdminClient } from "../../scripts/seed-admin";
import { formatGbp } from "../../src/lib/commerce";
import { seedPaidAdminOrder, signInStaff } from "./admin-fixtures";

test("finance sees cancellation without a refund and the separate flagged payment review", async ({ page }) => {
  const db = localAdminClient();
  const warehouse = await createLocalAdminUser("warehouse");
  const finance = await createLocalAdminUser("finance");
  const cancelled = await seedPaidAdminOrder({ sku: "EDG-Z50" });
  const mismatch = await seedPaidAdminOrder({ sku: "EDG-Z50", mismatch: true });
  const result = await db.rpc("cancel_order", {
    p_actor_id: warehouse.id, p_order_id: cancelled.id, p_operation_key: randomUUID(),
  });
  if (result.error) throw result.error;
  try {
    await signInStaff(page, finance);
    await page.getByRole("navigation", { name: "Staff areas" }).getByRole("link", { name: "Finance" }).click();
    const captures = page.getByRole("table", { name: "Outstanding captures" });
    await expect(captures.getByRole("row").filter({ hasText: cancelled.id })).toContainText(formatGbp(cancelled.gross));
    const reasons = page.getByRole("table", { name: "Payment review" });
    await expect(reasons.getByRole("row").filter({ hasText: mismatch.id })).toContainText("Payment amount or currency mismatch");
    const orders = page.getByRole("table", { name: "Orders and payment status" });
    const order = orders.getByRole("row").filter({ hasText: cancelled.id });
    await expect(order.getByRole("cell", { name: "Paid", exact: true })).toBeVisible();
    await expect(order.getByRole("cell", { name: "Cancelled", exact: true })).toBeVisible();
  } finally {
    const resolved = await db.rpc("resolve_refunded_payment_review", {
      p_actor_id: finance.id, p_order_id: mismatch.id, p_payment_intent_id: mismatch.paymentIntent!,
      p_refund_id: `re_${randomUUID().replaceAll("-", "")}`,
    });
    if (resolved.error) throw resolved.error;
  }
});
