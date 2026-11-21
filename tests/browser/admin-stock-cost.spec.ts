import { expect, test } from "@playwright/test";
import { createLocalAdminUser, localAdminClient } from "../../scripts/seed-admin";
import { signInStaff } from "./admin-fixtures";

test("the owner estimates cost, receives stock at actual cost, then records a signed adjustment", async ({ page }) => {
  const db = localAdminClient();
  const staff = await createLocalAdminUser("warehouse");
  const membership = await db.from("staff_members").insert({ user_id: staff.id, role: "catalogue" });
  if (membership.error) throw membership.error;
  const original = await db.from("variants").select("id,stock_on_hand,stock_reserved").eq("sku", "EDG-SUM-9802").single();
  if (original.error) throw original.error;
  const { id, stock_on_hand: onHand, stock_reserved: reserved } = original.data;
  await signInStaff(page, staff);
  await page.goto(`/admin/catalogue/${id}`);
  await page.getByLabel("Supplier unit price", { exact: true }).fill("16.90");
  await page.getByLabel("Supplier currency", { exact: true }).selectOption("USD");
  await page.getByLabel("Landed unit cost (£)", { exact: true }).fill("17");
  await page.getByRole("button", { name: "Save cost estimate" }).click();
  await expect(page.getByText("Cost estimate saved.", { exact: true })).toBeVisible();
  await expect(page.getByText(/below landed cost/i).first()).toBeVisible();

  await page.getByRole("navigation", { name: "Staff areas" }).getByRole("link", { name: "Stock", exact: true }).click();
  await page.getByRole("link", { name: "EDG-SUM-9802", exact: true }).click();
  await page.getByLabel("Received quantity").fill("8");
  await page.getByText("Add receipt costs (optional)").click();
  await page.getByLabel("Supplier unit price", { exact: true }).fill("4.20");
  await page.getByLabel("Supplier currency", { exact: true }).selectOption("USD");
  await page.getByLabel("Landed unit cost (£)", { exact: true }).fill("3.50");
  await page.getByRole("button", { name: "Record stock receipt" }).click();
  await expect(page.getByText("Stock receipt recorded.", { exact: true })).toBeVisible();
  const ledger = page.getByRole("table", { name: "Movement ledger" });
  const receipt = ledger.getByRole("row").filter({ hasText: "£3.50 landed" });
  await expect(receipt).toContainText("USD");
  await expect(receipt).toContainText("+8");

  await page.getByLabel("Quantity change").fill("-2");
  await page.getByLabel("Adjustment reason").selectOption("other");
  await page.getByRole("button", { name: "Record stock adjustment" }).click();
  await expect(page.getByRole("alert")).toContainText("A note is required for Other");
  await page.getByLabel("Quantity change").fill("-2");
  await page.getByLabel("Adjustment reason").selectOption("damaged");
  await page.getByLabel("Adjustment note").fill("Two damaged units in the test delivery");
  await page.getByRole("button", { name: "Record stock adjustment" }).click();
  await expect(page.getByText("Stock adjustment recorded.", { exact: true })).toBeVisible();
  const adjustment = ledger.getByRole("row").filter({ hasText: "Two damaged units" });
  await expect(adjustment).toContainText("Damaged");
  await expect(adjustment).toContainText("-2");
  await expect(adjustment).toContainText(staff.id);
  await page.getByLabel("Quantity change").fill(String(-(onHand + 7 - reserved)));
  await page.getByLabel("Adjustment reason").selectOption("count_correction");
  await page.getByRole("button", { name: "Record stock adjustment" }).click();
  await expect(page.getByRole("alert")).toContainText(/would remove|not enough available/i);

  await page.goto(`/admin/catalogue/${id}`);
  await expect(page.getByText("Latest costed receipt", { exact: true })).toBeVisible();
  await expect(page.getByText("£3.50", { exact: true })).toBeVisible();
  await expect(page.getByText(/below landed cost/i)).toHaveCount(0);
  expect((await db.from("variants").select("stock_on_hand,stock_reserved").eq("id", id).single()).data)
    .toEqual({ stock_on_hand: onHand + 6, stock_reserved: reserved });
});

test("finance can correct an estimate; warehouse-only staff cannot see cost fields or receipt costs", async ({ page, browser, baseURL }) => {
  const db = localAdminClient();
  const result = await db.from("variants").select("id").eq("sku", "EDG-SUM-9803").single();
  if (result.error) throw result.error;
  const { id } = result.data;
  await signInStaff(page, await createLocalAdminUser("finance"));
  await page.goto(`/admin/catalogue/${id}`);
  await expect(page.getByRole("heading", { name: "Selling prices" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save selling data" })).toHaveCount(0);
  await page.getByLabel("Supplier unit price", { exact: true }).fill("6.10");
  await page.getByLabel("Supplier currency", { exact: true }).selectOption("USD");
  await page.getByLabel("Landed unit cost (£)", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Save cost estimate" }).click();
  await expect(page.getByText("Cost estimate saved.", { exact: true })).toBeVisible();
  await page.getByLabel("Landed unit cost (£)", { exact: true }).fill("4.75");
  await page.getByRole("button", { name: "Save cost estimate" }).click();
  await expect(page.getByText("£4.75", { exact: true })).toBeVisible();

  const warehouse = await browser.newPage({ baseURL });
  try {
    await signInStaff(warehouse, await createLocalAdminUser("warehouse"));
    await warehouse.goto(`/admin/catalogue/${id}`);
    await expect(warehouse).toHaveURL("/admin");
    await warehouse.goto(`/admin/stock/${id}`);
    await expect(warehouse.getByText("Add receipt costs (optional)")).toHaveCount(0);
    await expect(warehouse.getByText("Receipt cost per blade")).toHaveCount(0);
    expect(await warehouse.content()).not.toContain("landed_unit_pence");
  } finally {
    await warehouse.close();
  }
});
