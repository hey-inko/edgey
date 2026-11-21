import { afterEach, expect, it, vi } from "vitest";
import { GET as sendConfirmations } from "@/app/api/cron/order-confirmations/route";
import { GET as reconcilePayments } from "@/app/api/cron/stripe-reconciliation/route";
import { drainFinanceRetries } from "@/lib/admin/replay";
import { processOrderConfirmations } from "@/lib/email/outbox";
import { reconcileStripePayments } from "@/lib/payments/reconciliation";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/replay", () => ({ drainFinanceRetries: vi.fn() }));
vi.mock("@/lib/email/outbox", () => ({ processOrderConfirmations: vi.fn(), replayOrderConfirmation: vi.fn() }));
vi.mock("@/lib/email/provider", () => ({ emailConfigurationError: () => null }));
vi.mock("@/lib/payments/reconciliation", () => ({ reconcileStripePayments: vi.fn(), replayStripeEvent: vi.fn() }));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it.each([
  {
    kind: "event",
    handler: reconcilePayments,
    primary: reconcileStripePayments,
    counts: { eventsChecked: 1, ordersChecked: 2, tradeOrdersChecked: 0, unresolvedEvents: 0, unresolvedOrders: 0, unresolvedTradeOrders: 0 },
  },
  {
    kind: "confirmation",
    handler: sendConfirmations,
    primary: processOrderConfirmations,
    counts: { sent: 1, failed: 0, pending: 0 },
  },
] as const)("runs the primary $kind worker even when finance cannot claim retries", async ({ kind, handler, primary, counts }) => {
  const cronSecret = "test-only-cron-secret-at-least-32-bytes";
  vi.stubEnv("CRON_SECRET", cronSecret);
  const failure = Promise.withResolvers<never>();
  vi.mocked(drainFinanceRetries).mockReturnValueOnce(failure.promise);
  if (kind === "event") vi.mocked(reconcileStripePayments).mockResolvedValueOnce(counts);
  else vi.mocked(processOrderConfirmations).mockResolvedValueOnce(counts);
  const response = handler(new Request("https://example.test/api/cron", { headers: { Authorization: `Bearer ${cronSecret}` } }));
  expect(primary).toHaveBeenCalledOnce();
  expect(drainFinanceRetries).toHaveBeenCalledWith(kind, expect.any(Function));
  failure.reject(new Error("Fixture internal failure"));
  const result = await response;
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ ...counts, finance: { error: "Could not process finance retries." } });
});
