import { expect, test } from "@playwright/test";

test("restores the theme but resets the material proof and view on reload", async ({ page }) => {
  await page.goto("/");
  const study = page.locator(".study");
  await expect(study).toHaveAttribute("data-mode", "ink");
  await expect(page.getByRole("button", { name: "Prism", exact: true })).toHaveAttribute("aria-pressed", "true");
  const texture = study.locator("#printed-texture");
  for (const [label, key] of [["Coral", "coral"], ["Glacier", "cyan"], ["Citron", "lime"], ["Violet", "violet"]]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(texture).toHaveAttribute("href", "/proofs/proof-" + key + ".webp");
  }
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  await expect(study.locator(".ink-image")).toHaveCSS("opacity", "0");
  await page.getByRole("button", { name: "Ink", exact: true }).click();
  await expect(texture).toHaveAttribute("href", "/proofs/proof-violet.webp");
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  await page.getByRole("button", { name: "Glacier", exact: true }).click();
  await expect(study).toHaveAttribute("data-mode", "ink");
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(texture).toHaveAttribute("href", "/proofs/proof-cyan.webp");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 250, 248)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#FAFAF8");
  await expect(study).toHaveAttribute("data-mode", "ink");
  await expect(texture).toHaveAttribute("href", "/proofs/proof-prism.webp");
});

test("the home keyboard path opens a shareable dialog and returns focus on Escape", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to catalogue" })).toBeFocused();
  await page.keyboard.press("/");
  const search = page.getByRole("searchbox");
  await expect(search).toBeFocused();
  await expect(page.locator(".search-field")).toHaveCSS("outline-color", "rgb(155, 227, 249)");
  await search.fill("3910-301");
  await expect(page.getByRole("status")).toHaveText("1 blade shown.");

  const card = page.getByRole("link", { name: "EDG-Z10 Flat-stock drag blade" });
  await expect(card).toContainText("Exact match · 3910301");
  await expect(card.locator("img")).toHaveCSS("transition-duration", "0s");
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/blades\/edg-z10$/);
  const dialog = page.getByRole("dialog", { name: "Flat-stock drag blade" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "5", exact: true }).click();
  await expect(dialog).toContainText("£99.75");
  await expect(dialog).toContainText("£19.95 each · ex VAT");
  await expect(dialog).toContainText("£119.70 inc VAT (20%)");
  await expect(dialog.getByRole("button", { name: "Add to selection" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\?q=3910-301$/);
  await expect(dialog).not.toBeVisible();
  await expect(card).toBeFocused();
});

test("presents every ambiguous configuration, and a distinct SKU preselects the variant", async ({ page }) => {
  await page.goto("/blades?q=spb%200030");
  const family = page.getByRole("link", { name: /EDG-MIM-45 Mimaki-pattern plotter blade/ });
  await expect(family).toContainText("Exact match · SPB-0030");
  await expect(family).toContainText("45° or 60°");
  await family.click();
  await expect(page).toHaveURL(/\/blades\/edg-mim-45$/);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Choose the configuration");
  await expect(dialog.getByRole("button", { name: "45°", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.getByRole("button", { name: "60°", exact: true })).toHaveAttribute("aria-pressed", "false");
  await dialog.getByRole("button", { name: "60°", exact: true }).click();
  await expect(page).toHaveURL(/variant=EDG-MIM-A60$/);
  await expect(dialog.getByRole("button", { name: "60°", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveValue("spb 0030");

  await page.getByRole("searchbox").fill("eDg mIm-A45");
  await expect(family).toContainText("Exact match · EDG-MIM-A45");
  await family.click();
  await expect(page).toHaveURL(/variant=EDG-MIM-A45$/);
  await expect(dialog.getByRole("button", { name: "45°", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("a search response does not overwrite newer typing", async ({ page }) => {
  let markRequest!: () => void;
  let releaseRequest!: () => void;
  const seen = new Promise<void>((resolve) => { markRequest = resolve; });
  const release = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route((url) => url.searchParams.get("q") === "Foa", async (route) => {
    markRequest();
    await release;
    await route.continue();
  });

  await page.goto("/blades");
  const search = page.getByRole("searchbox");
  await search.fill("Foa");
  await seen;
  await search.press("m");
  releaseRequest();
  await page.waitForURL((url) => url.searchParams.get("q") === "Foa");
  await expect(search).toHaveValue("Foam");
  await expect(page).toHaveURL(/\?q=Foam$/);
});

test("filters published tool types and materials and carries an unmatched code to the enquiry", async ({ page }) => {
  await page.goto("/blades");
  await expect(page.getByRole("heading", { name: "Blade catalogue" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The cutting room." })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Tool type" }).selectOption("kiss-cut");
  await expect(page.getByRole("status")).toHaveText("1 blade shown.");
  await expect(page.getByRole("link", { name: "EDG-Z1 Kiss-cut blade" })).toBeVisible();
  await page.getByRole("link", { name: /Corrugated board.*2 blades/ }).click();
  await expect(page.getByRole("status")).toHaveText("2 blades shown.");
  await expect(page.getByRole("combobox", { name: "Tool type" })).toHaveValue("");
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.getByRole("link", { name: "Clear filters" }).click();
  await page.getByRole("searchbox").fill("5201345");
  const ask = page.getByRole("link", { name: "Ask us to match this blade" });
  await expect(ask).toBeVisible();
  await expect(page.getByRole("link", { name: /EDG-Z71/ })).toHaveCount(0);
  await ask.click();
  await expect(page).toHaveURL(/\/enquiry\?q=5201345$/);
  await expect(page.getByRole("textbox", { name: "Your search" })).toHaveValue("5201345");
  await expect(page.getByRole("button", { name: "Send enquiry" })).toBeEnabled();
});

test("direct visits render a standalone verified product with per-blade price breaks", async ({ page, baseURL }) => {
  await page.goto("/blades/edg-z10");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Flat-stock drag blade", level: 1 })).toBeVisible();
  await expect(page).toHaveTitle(/EDG-Z10.*Zünd Z10/);
  await expect(page.getByText("Zünd Z10 / 3910301")).toBeVisible();
  await expect(page.getByText("In stock", { exact: true })).toBeVisible();
  const breaks = page.getByRole("table", { name: "Price breaks per blade for EDG-Z10" });
  await expect(breaks.getByRole("row", { name: /5–9 blades £19\.95 £23\.94/ })).toBeVisible();
  const jsonLd = await page.locator('script[type="application/ld+json"]').textContent();
  expect(JSON.parse(jsonLd ?? "{}")).toMatchObject({
    "@type": "Product",
    sku: "EDG-Z10",
    url: baseURL + "/blades/edg-z10",
    image: baseURL + "/line-art/drag-line.svg",
    offers: { url: baseURL + "/blades/edg-z10", priceCurrency: "GBP" },
  });
  expect(await page.content()).not.toMatch(/PRIV-Z10-ALIAS|500-9802|FIXTURE-EDG-Z10/);
  const quantity = page.getByRole("spinbutton", { name: "Quantity", exact: true });
  await quantity.fill("0");
  await expect(quantity).toHaveAttribute("aria-invalid", "true");
  await expect(quantity).toHaveAccessibleDescription("Enter a positive whole quantity to see the total.");
  await quantity.fill("6");
  await expect(page.locator(".detail-total")).toContainText("£119.70 ex VAT");

  await page.goto("/blades/edg-sum-drg?variant=EDG-SUM-DRG-60");
  await expect(page.getByRole("button", { name: "60° · Out of stock" })).toBeDisabled();
  await expect(page.getByText("Out of stock", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "36°", exact: true })).toBeEnabled();
});

test("malformed searches do not crash and an unknown product returns 404", async ({ page }) => {
  expect((await page.goto("/blades?q=%00"))?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Blade catalogue" })).toBeVisible();
  expect((await page.goto("/?q=52%00%0B01345"))?.status()).toBe(200);
  await expect(page.getByRole("link", { name: /EDG-Z71/ })).toHaveCount(0);
  expect((await page.goto("/blades/no-such-blade"))?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "We could not find that page" })).toBeVisible();
});

for (const width of [390, 320]) {
  test(`the home, catalogue and product fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 844 });
    for (const route of ["/", "/blades", "/blades/edg-z10", "/blades/edg-mim-45?variant=EDG-MIM-A45", "/enquiry?q=5201345"]) {
      await page.goto(route);
      const overflows = () =>
        page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(await overflows()).toBe(false);
      if (route === "/") {
        const key = page.locator(".layer-key");
        await expect(key).toBeVisible();
        await expect(key).toHaveText("Print face / Fluted core / Back liner");
        await expect(page.getByRole("button", { name: "Glacier", exact: true })).toBeVisible();
        await expect(page.locator(".cards")).toHaveCSS("grid-template-columns", /^\d+px \d+px$/);
      }
      if (route.startsWith("/blades/")) await expect(page.locator(".detail-total")).toBeInViewport({ ratio: 1 });
    }
  });
}
