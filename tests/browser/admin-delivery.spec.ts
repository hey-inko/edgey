import { expect, test } from "@playwright/test";
import { createLocalAdminUser } from "../../scripts/seed-admin";
import { signInStaff } from "./admin-fixtures";

test("warehouse staff save and remove a configured district service", async ({ page }) => {
  await signInStaff(page, await createLocalAdminUser("warehouse"));
  await page.getByRole("link", { name: "Delivery settings" }).click();
  await expect(page.getByRole("heading", { name: "Delivery settings" })).toBeVisible();
  await page.getByLabel("Rule scope").selectOption("district");
  await page.getByLabel("Postcode area or district").fill("SW99");
  await page.getByLabel("Service type").selectOption("agreed");
  await page.getByLabel("Service name").fill("Fixture three-day service");
  await page.getByLabel("Agreed price ex VAT (pence)").fill("995");
  await page.getByLabel("Agreed transit (working days)").fill("3");
  await page.getByRole("button", { name: "Save postcode rule" }).click();
  await expect(page.getByText("Delivery rule saved.")).toBeVisible();
  const rule = page.getByRole("link", { name: "SW99", exact: true });
  await rule.click();
  await expect(page.getByRole("heading", { name: "Edit SW99 district rule" })).toBeVisible();
  await expect(page.getByLabel("Service name")).toHaveValue("Fixture three-day service");
  await page.getByRole("checkbox", { name: /Remove this rule/ }).check();
  await page.getByRole("button", { name: "Remove rule" }).click();
  await expect(rule).toHaveCount(0);
});
