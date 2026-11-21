import { chromium, devices } from "@playwright/test";

const origin = URL.parse(process.argv[2] ?? "");
const runs = Number(process.argv[3] ?? "20");
if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
  !Number.isInteger(runs) || runs < 5 || runs > 100) {
  throw new Error("Usage: node scripts/bench-finder-mobile.mjs <running-storefront-origin> [runs: 5–100]");
}

const url = new URL("/", origin).href;
const browser = await chromium.launch();
const samples = [];
try {
  for (let i = 0; i <= runs; i++) {
    const context = await browser.newContext({ ...devices["iPhone 13"], userAgent: devices["iPhone 13"].userAgent + " EdgeyFinderBenchmarkBot/1.0" });
    try {
      const page = await context.newPage();
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const started = performance.now();
      await page.getByRole("searchbox").fill("3910301");
      await page.getByRole("link", { name: /EDG-Z10 Flat-stock drag blade/ })
        .filter({ hasText: "Exact match" }).waitFor({ timeout: 10_000 });
      if (i > 0) samples.push(performance.now() - started);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

samples.sort((a, b) => a - b);
const percentile = (p) => Math.round(samples[Math.ceil(samples.length * p) - 1]);
console.log(`Mobile Chromium (390px, no artificial throttling), warm server, ${runs} fresh contexts.`);
console.log(`Input to visible exact result, including debounce: median ${percentile(0.5)} ms; p95 ${percentile(0.95)} ms.`);
