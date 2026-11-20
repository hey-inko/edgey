import { describe, expect, test, vi } from "vitest";
import { accountDate } from "@/lib/account/display";
import { compareReorder } from "@/lib/account/reorder";
import { quoteSelectionWith } from "@/lib/checkout/quote";
import { startCheckoutAttempt } from "@/lib/checkout/server";
import { getVerifiedBuyer } from "@/lib/auth/server";
import { prepareCheckoutAttempt } from "@/lib/checkout/attempt";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/server", () => ({ getVerifiedBuyer: vi.fn() }));
vi.mock("@/lib/checkout/attempt", () => ({ prepareCheckoutAttempt: vi.fn() }));

const stocked = "57f4a2c1-ec92-476f-b362-616793ede231";
const unavailable = "57f4a2c1-ec92-476f-b362-616793ede232";

describe("buyer account", () => {
  test("uses London dates for UTC order and dispatch instants", () => {
    expect(accountDate("2026-07-14T23:20:00.000Z")).toBe("15 Jul 2026");
    expect(accountDate("2026-07-14")).toBe("14 Jul 2026");
  });

  test("previews a reorder at current stock and the quantity-adjusted price tier", async () => {
    const previous = [
      { variant_id: stocked, sku: "EDG-A01", option_label: "45°", quantity: 5, unit_price_pence: 850 },
      { variant_id: unavailable, sku: "EDG-A02", option_label: "60°", quantity: 1, unit_price_pence: 950 },
    ];
    const quote = await quoteSelectionWith([
      { variantId: stocked, quantity: 5 },
      { variantId: unavailable, quantity: 1 },
    ], undefined, {
      now: () => new Date("2026-11-20T12:00:00Z"),
      lookup: async () => [{
        id: stocked, sku: "EDG-A01", optionLabel: "45°", availableQuantity: 4,
        tierPrices: { oneToFour: 1000, fiveToNine: 900, tenPlus: 800 },
      }],
    });
    expect(quote.status).toBe("ok");
    if (quote.status !== "ok") return;
    expect(compareReorder(previous, quote)).toMatchObject({
      lines: [{ variantId: stocked, quantity: 4 }],
      goodsNetPence: 4000,
      items: [
        { sku: "EDG-A01", previousQuantity: 5, previousUnitPence: 850, current: { quantity: 4, unitPence: 1000 } },
        { sku: "EDG-A02", current: null },
      ],
    });
  });

  test("gets checkout ownership from the verified session, never the form", async () => {
    const orderInput = { contact: { email: "checkout@example.com" } };
    const ready = { status: "ready", orderInput };
    vi.mocked(prepareCheckoutAttempt).mockResolvedValue(ready as Awaited<ReturnType<typeof prepareCheckoutAttempt>>);
    const input = { buyerId: unavailable, fields: orderInput.contact };

    vi.mocked(getVerifiedBuyer).mockResolvedValueOnce({ id: stocked, email: "buyer@example.com" });
    expect(await startCheckoutAttempt(input)).toEqual({ ...ready, buyerId: stocked });
    vi.mocked(getVerifiedBuyer).mockResolvedValueOnce(null);
    expect((await startCheckoutAttempt(input))).toEqual({ ...ready, buyerId: undefined });
    expect(orderInput).not.toHaveProperty("buyerId");
  });
});
