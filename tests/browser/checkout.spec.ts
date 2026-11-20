import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

const storageKey = "edgey-storefront-selection-v1";

function selection(page: Page) {
  return page.getByRole("dialog", { name: "Your selection" });
}

async function addZ10(page: Page, quantity: "1" | "5" | "10" = "5") {
  await page.goto("/blades/edg-z10");
  await page.getByRole("button", { name: quantity, exact: true }).click();
  await page.getByRole("button", { name: "Add to selection" }).click();
  await expect(selection(page).getByRole("button", { name: "Remove EDG-Z10" })).toBeVisible();
}

async function fillAddress(page: Page, postcode = "SW1A 1AA") {
  await page.getByLabel("Business name").fill("Example Print Studio");
  await page.getByLabel("Contact email").fill("orders@example.com");
  await page.getByLabel("I’m buying for work").check();
  await page.getByLabel("Recipient name").fill("Alex Morgan");
  await page.getByLabel("Address line 1").fill("10 Sample Street");
  await page.getByLabel("Town or city").fill("London");
  await page.getByLabel("Postcode").fill(postcode);
}

test("a keyboard add opens the selection, which reprices, persists and can be emptied", async ({ page }) => {
  await page.goto("/blades?q=3910301");
  const card = page.getByRole("link", { name: "EDG-Z10 Flat-stock drag blade" });
  await card.focus();
  await page.keyboard.press("Enter");
  const product = page.getByRole("dialog", { name: "Flat-stock drag blade" });
  await product.getByRole("button", { name: "5", exact: true }).press("Enter");
  await expect(product).toContainText("£119.70 inc VAT (20%)");
  await product.getByRole("button", { name: "Add to selection" }).press("Enter");
  const tray = selection(page);
  await expect(tray).toBeVisible();
  await expect(product).not.toBeVisible();
  await expect(tray).toContainText("5 × £19.95 = £99.75");
  await expect(tray).toContainText("£50.25 more ex VAT for free delivery");
  await expect(tray).toContainText("£128.04");

  const quantity = tray.getByRole("spinbutton", { name: "Quantity for EDG-Z10" });
  await quantity.fill("0");
  await expect(quantity).toHaveAccessibleDescription("Enter a positive whole quantity.");
  await quantity.fill("9");
  await expect(tray.getByRole("button", { name: "Go to checkout" })).toBeDisabled();
  await quantity.press("Enter");
  await expect(quantity).toBeFocused();
  await expect(tray).toContainText("9 × £19.95 = £179.55");
  await expect(tray).toContainText("Add one blade and save £4.55 ex VAT");
  await quantity.fill("10");
  await tray.getByRole("button", { name: "Update quantity for EDG-Z10" }).click();
  await expect(tray).toContainText("10 × £17.50 = £175.00");

  await page.keyboard.press("Escape");
  const trigger = page.getByRole("button", { name: "Open selection, 10 blades" });
  await expect(trigger).toBeFocused();
  await page.reload();
  await trigger.click();
  await expect(tray).toContainText("10 × £17.50 = £175.00");
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), storageKey);
  expect(Object.entries(stored)).toEqual([[expect.stringMatching(/^[\da-f-]{36}$/), 10]]);
  await tray.getByRole("button", { name: "Remove EDG-Z10" }).click();
  await expect(tray).toContainText("Your selection is empty.");
  await expect(tray.getByRole("button", { name: "Continue browsing" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open selection, 0 blades" })).toBeFocused();
});

test("blocked storage leaves the in-memory selection usable across navigation", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get: () => { throw new DOMException("Blocked", "SecurityError"); } });
  });
  await addZ10(page, "1");
  await selection(page).getByRole("link", { name: "Go to checkout" }).click();
  await expect(page).toHaveURL("/checkout");
  await expect(page.getByRole("button", { name: "Open selection, 1 blade" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Order summary" })).toContainText("1 × £22.50 = £22.50");
});

test("stale selections identify unavailable lines and require acceptance before checkout", async ({ page }) => {
  if (!process.env.SUPABASE_DB_URL) loadEnvFile(".env.local");
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await db.connect();
  let stored: Record<string, number>;
  try {
    const { rows } = await db.query<{ id: string; sku: string }>(
      "select id, sku from public.variants where sku in ('EDG-Z10', 'EDG-Z11', 'EDG-SUM-DRG-60')",
    );
    expect(rows).toHaveLength(3);
    stored = Object.fromEntries(rows.map(({ id, sku }) => [id, sku === "EDG-Z10" ? 41 : 1]));
  } finally {
    await db.end();
  }
  await page.addInitScript(({ key, items }) => localStorage.setItem(key, JSON.stringify(items)), { key: storageKey, items: stored });
  await page.goto("/blades");
  await page.getByRole("button", { name: "Open selection, 43 blades" }).click();
  const tray = selection(page);
  await expect(tray.getByRole("status")).toContainText(/EDG-Z10.*41.*40/);
  await expect(tray.getByRole("status")).toContainText(/EDG-SUM-DRG-60.*out of stock/i);
  await expect(tray.getByRole("status")).toContainText(/unavailable item/i);
  await expect(tray.getByRole("link", { name: "Go to checkout" })).toHaveCount(0);
  await tray.getByRole("button", { name: "Accept changes" }).click();
  await tray.getByRole("link", { name: "Go to checkout" }).click();
  await expect(page.getByRole("region", { name: "Order summary" })).toContainText("40 × £17.50 = £700.00");
  await expect(page.getByRole("button", { name: "Open selection, 40 blades" })).toBeVisible();
});

test("checkout validates before payment and retains the same attempt until a material change", async ({ page }) => {
  await addZ10(page);
  await selection(page).getByRole("link", { name: "Go to checkout" }).click();
  const summary = page.getByRole("region", { name: "Order summary" });
  const pay = page.getByRole("button", { name: "Continue to payment" });
  const amount = page.locator(".checkout-amount");
  await expect(summary).toContainText("5 × £19.95 = £99.75");
  await expect(summary).toContainText("£119.70 inc VAT (20%)");

  await pay.click();
  await expect(page.getByLabel("Business name")).toHaveAccessibleDescription("Enter your business name.");
  await fillAddress(page, "BT1 5GS");
  const enquiry = page.getByRole("link", { name: "Ask us about delivery" });
  await expect(enquiry).toHaveAttribute("href", "/enquiry?topic=delivery");
  await expect(page.getByLabel("Postcode")).toHaveAccessibleDescription("Online delivery isn’t available for this postcode.");
  await expect(pay).toBeDisabled();
  await expect(amount).toHaveCount(0);

  await page.getByLabel("Postcode").fill("sw1a1aa");
  await expect(summary).toContainText("Next working day");
  await expect(summary).toContainText("Dates are provisional until payment.");
  await expect(summary).toContainText("£6.95");
  await expect(summary).toContainText("£21.34");
  await expect(amount).toContainText("£128.04");

  const tokens: string[] = [];
  page.on("request", (request) => {
    const token = request.method() === "POST" && request.postData()?.match(/"attemptToken":"([\da-f-]+)"/)?.[1];
    if (token) tokens.push(token);
  });
  await pay.click();
  const complete = page.getByText("Payment is not connected in this build.");
  await expect(complete).toBeVisible();
  await pay.click();
  await expect.poll(() => tokens.length).toBe(2);
  await expect(complete).toBeVisible();
  expect(tokens[1]).toEqual(tokens[0]);
  await page.getByLabel("Address line 1").fill("12 Sample Street");
  await expect(complete).toHaveCount(0);
  await pay.click();
  await expect(complete).toBeVisible();
  expect(tokens).toHaveLength(3);
  expect(tokens[2]).not.toEqual(tokens[0]);

  await summary.getByRole("button", { name: "Edit selection" }).click();
  const tray = selection(page);
  const qty = tray.getByRole("spinbutton", { name: "Quantity for EDG-Z10" });
  await qty.fill("10");
  await qty.press("Enter");
  await expect(tray).toContainText("10 × £17.50 = £175.00");
  await tray.getByRole("button", { name: "Return to checkout" }).click();
  await expect(summary.getByRole("button", { name: "Edit selection" })).toBeFocused();
  await expect(amount).toContainText("£210.00");
  await expect(page.getByLabel("Address line 1")).toHaveValue("12 Sample Street");
  await pay.click();
  await expect(complete).toBeVisible();
  expect(tokens).toHaveLength(4);
  expect(tokens[3]).not.toEqual(tokens[2]);
});

for (const width of [1440, 390, 320]) {
  for (const theme of ["dark", "light"] as const) {
    test(`selection and checkout fit ${width}px in ${theme} with visible keyboard focus`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1440 ? 1080 : width === 390 ? 844 : 568 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript((value) => localStorage.setItem("edgey-theme", value), theme);
      await page.goto("/blades/edg-z16");
      await page.getByRole("button", { name: "Add to selection" }).click();
      await selection(page).getByRole("button", { name: "Continue browsing" }).click();
      await page.goto("/blades?q=3910301");
      await page.getByRole("link", { name: "EDG-Z10 Flat-stock drag blade" }).click();
      await page.getByRole("button", { name: "5", exact: true }).click();
      await page.getByRole("button", { name: "Add to selection" }).click();
      const tray = selection(page);
      const checkout = tray.getByRole("link", { name: "Go to checkout" });
      await expect(checkout).toBeVisible();
      await expect(tray.getByRole("listitem")).toHaveCount(2);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await tray.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(await tray.evaluate((el) => el.clientWidth));
      const rootWidth = () => page.evaluate(() => document.documentElement.scrollWidth);
      expect(await rootWidth()).toBe(width);

      const renderDir = process.env.EDGEY_CHECKOUT_RENDER_DIR;
      if (renderDir) {
        await mkdir(renderDir, { recursive: true });
        await page.screenshot({ path: join(renderDir, `selection-${theme}-${width}.png`), animations: "disabled" });
        if (width !== 1440) {
          await checkout.scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(renderDir, `selection-totals-${theme}-${width}.png`), animations: "disabled" });
        }
      }
      await checkout.click();
      await fillAddress(page);
      await expect(page.getByRole("region", { name: "Order summary" })).toContainText("Next working day");
      expect(await rootWidth()).toBe(width);
      const postcode = page.getByLabel("Postcode");
      await postcode.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(postcode).toBeFocused();
      await expect(postcode).toHaveCSS("outline-color", theme === "dark" ? "rgb(155, 227, 249)" : "rgb(33, 93, 173)");
      if (renderDir) {
        await postcode.blur();
        await page.screenshot({ path: join(renderDir, `checkout-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
      }
    });
  }
}
