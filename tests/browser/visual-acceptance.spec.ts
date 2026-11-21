import { expect, test } from "@playwright/test";

test("a saved light theme sets the browser colour before hydration", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("edgey-theme", "light"));
  let scriptsBlocked = 0;
  await page.route(/\/_next\/static\/.*\.js(?:\?|$)/, (route) => {
    scriptsBlocked++;
    return route.abort();
  });

  await page.goto("/");
  expect(scriptsBlocked).toBeGreaterThan(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 250, 248)");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#FAFAF8");
});

test("proof names and the populated masthead fit at 320px with enlarged text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => {
    localStorage.setItem("edgey-storefront-selection-v1", '{"42e5ce02-4d5e-5c39-9f1b-f76c46c8b386":200}');
  });
  await page.goto("/");
  const selection = page.getByRole("button", { name: "Open selection, 200 blades" });
  await expect(selection).toBeVisible();
  const names = page.locator(".proof-option span");
  await expect(names).toHaveText(["Prism", "Coral", "Glacier", "Citron", "Violet"]);
  expect(await names.evaluateAll((labels) => new Set(labels.map((label) => label.getBoundingClientRect().top)).size)).toBe(1);

  await page.evaluate(() => { document.documentElement.style.fontSize = "125%"; });
  expect(await names.evaluateAll((labels) => labels.filter((label) => {
    const text = document.createRange();
    text.selectNodeContents(label);
    return text.getBoundingClientRect().right > label.closest("button")!.getBoundingClientRect().right;
  }).map((label) => label.textContent))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await expect(selection).toBeInViewport({ ratio: 1 });
});
