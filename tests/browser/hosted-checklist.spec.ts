import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

async function delayHydration(page: Page, path: string, edit: () => Promise<void>) {
  const scripts = Promise.withResolvers<void>();
  await page.route("**/_next/static/**/*.js", async (route) => {
    await scripts.promise;
    await route.continue();
  });
  try {
    await page.goto(path, { waitUntil: "commit" });
    await expect(page.getByRole("button", { name: "Selection 0 blades" })).toBeDisabled();
    await edit();
  } finally {
    scripts.resolve();
  }
  await expect(page.getByRole("button", { name: "Selection 0 blades" })).toBeEnabled();
}

test("keeps pre-hydration enquiry edits through further input, validation and submission", async ({ page }) => {
  const email = `early-enquiry-${randomUUID()}@example.test`;
  const reply = page.getByLabel("Reply email");
  const brand = page.getByLabel("Machine brand");
  const message = page.getByRole("textbox", { name: "Message" });
  await delayHydration(page, "/enquiry?q=EDGEY-HYDRATION-CHECK", async () => {
    await reply.pressSequentially(email);
    await brand.selectOption({ label: "JWEI" });
  });
  await message.fill("Short");
  await expect(reply).toHaveValue(email);
  await expect(brand).toHaveValue("jwei");
  await message.clear();

  const submit = page.getByRole("button", { name: "Send enquiry" });
  await submit.click();
  await expect(page.getByRole("heading", { name: "Check the form" })).toBeFocused();
  await expect(reply).toHaveValue(email);
  await expect(brand).toHaveValue("jwei");
  await message.fill("Can you confirm which holder this blade fits?");
  await submit.click();
  await expect(page.getByRole("heading", { name: "Enquiry received" })).toBeFocused();
});

test("includes pre-hydration Finder edits when a third filter changes", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search by part number, machine or material" });
  const type = page.getByRole("combobox", { name: "Tool type" });
  const machine = page.locator('select[name="machine"]');
  await delayHydration(page, "/blades", async () => {
    await search.pressSequentially("3910301");
    await type.selectOption({ label: "Drag" });
  });
  await machine.selectOption({ index: 1 });
  const selected = await machine.inputValue();
  await expect(page).toHaveURL((url) => url.searchParams.get("q") === "3910301" &&
    url.searchParams.get("type") === "drag" && url.searchParams.get("machine") === selected);
  await expect(search).toHaveValue("3910301");
  await expect(type).toHaveValue("drag");
});

test.describe("native staff sign-in", () => {
  test.use({ javaScriptEnabled: false });

  test("returns the usual form error rather than a 500 before hydration", async ({ page, baseURL }) => {
    const initial = await page.goto("/admin/sign-in");
    expect(initial?.headers()).toMatchObject({
      "referrer-policy": "same-origin",
      "cache-control": expect.stringContaining("no-store"),
    });
    await page.getByLabel("Work email").fill(`early-staff-${randomUUID()}@example.test`);
    await page.getByLabel("Password").fill("fictional-password");
    const response = page.waitForResponse((candidate) =>
      new URL(candidate.url()).pathname === "/admin/sign-in" && candidate.request().method() === "POST");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const post = await response;
    expect(post.status()).toBe(200);
    expect(await post.request().headerValue("origin")).toBe(baseURL);
    await expect(page.getByRole("alert")).toHaveText("Could not sign in. Check your staff email and password.");
  });
});

test("keeps the compact dialog close and checkout action in view", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/blades?q=3910301");
  const card = page.getByRole("link", { name: /EDG-Z10/ }).first();
  await card.click();
  const product = page.getByRole("dialog", { name: /blade/i });
  const close = product.getByRole("button", { name: "Close blade details" });
  const spec = product.getByRole("link", { name: "Full specification and price breaks" });
  await expect(close).toBeInViewport({ ratio: 1 });
  await spec.scrollIntoViewIfNeeded();
  await expect(spec).toBeInViewport({ ratio: 1 });
  await expect(spec.locator("svg")).toHaveCSS("display", "inline-block");
  await expect(spec.getByText("breaks", { exact: true })).toHaveCSS("white-space", "nowrap");
  await expect(close).toBeInViewport({ ratio: 1 });
  await close.click();
  await expect(card).toBeFocused();
  await card.click();
  await product.getByRole("button", { name: "Add to selection" }).click();
  const tray = page.getByRole("dialog", { name: "Your selection" });
  const checkout = tray.getByRole("link", { name: "Go to checkout" });
  await expect(checkout).toBeInViewport({ ratio: 1 });
  await checkout.click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByRole("heading", { name: "Order summary" })).toBeVisible();
});
