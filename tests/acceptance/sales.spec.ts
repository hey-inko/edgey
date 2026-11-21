import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { createLocalAdminUser } from "../../scripts/seed-admin";
import { setVerifiedStaffSession } from "../browser/admin-fixtures";
import { database } from "./storefront-fixtures";

test("staging demo orders feed the finance dashboard and cleanup restores stock", async ({ page, baseURL }) => {
  const db = await database();
  const balances = async () => (await db.query(
    "select id, stock_on_hand, stock_reserved from public.variants order by id",
  )).rows;
  const finance = await createLocalAdminUser("finance");
  const beforeStock = await balances();
  const beforeOrders = (await db.query("select id from public.orders order by id")).rows;
  try {
    execFileSync("pnpm", ["demo:orders", "--local"], { stdio: ["ignore", "pipe", "pipe"] });
    expect(await balances()).not.toEqual(beforeStock);
    expect((await db.query("select id from public.orders order by id")).rows.length).toBeGreaterThan(beforeOrders.length);
    await setVerifiedStaffSession(page, finance, baseURL);
    await page.goto("/admin/sales?grain=week");
    await expect(page.getByRole("heading", { name: "Sales", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: /bar chart of booked product revenue/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Payment methods" }).locator("..")).toContainText("Net 30");
    await expect(page.getByRole("table", { name: "Product sales" })).toContainText("Cost missing");
    await page.getByText("How these figures are worked out").click();
    await expect(page.getByText(/free trial packs do not/)).toBeVisible();
    const exportUrl = (await page.getByRole("link", { name: "Download daily sales CSV" }).getAttribute("href"))!;
    const csv = await page.request.get(exportUrl);
    expect(csv.ok()).toBe(true);
    expect((await csv.text()).trim().split("\r\n")).toHaveLength(31);
  } finally {
    try {
      execFileSync("pnpm", ["demo:orders:clean", "--local"], { stdio: ["ignore", "pipe", "pipe"] });
      expect(await balances()).toEqual(beforeStock);
      expect((await db.query("select id from public.orders order by id")).rows).toEqual(beforeOrders);
    } finally {
      await db.end();
    }
  }
});
