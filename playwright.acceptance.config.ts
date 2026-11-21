import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.ACCEPTANCE_BASE_URL;
if (!baseURL || !process.env.ACCEPTANCE_STRIPE_URL || !process.env.ACCEPTANCE_CLOCK_FILE) {
  throw new Error("Start the isolated acceptance environment with pnpm test:acceptance.");
}
const port = new URL(baseURL).port;

export default defineConfig({
  testDir: "./tests/acceptance",
  outputDir: "./test-results/acceptance",
  forbidOnly: true,
  workers: 1,
  timeout: 60_000,
  use: { ...devices["Desktop Chrome"], baseURL, actionTimeout: 10_000, trace: "retain-on-failure" },
  webServer: {
    command: `node --import ./tests/acceptance/next-preload.mjs ./node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
