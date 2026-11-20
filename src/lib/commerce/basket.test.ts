import { describe, expect, it } from "vitest";
import {
  calculateBasket,
  priceLine,
  STANDARD_DELIVERY_QUOTE,
  type CommerceVariant,
  type DeliveryQuote,
  type LineRequest,
} from "./index";

const z10: CommerceVariant = {
  id: "z10",
  sku: "EDG-Z10",
  optionLabel: "50°",
  availableQuantity: 20,
  tierPrices: { oneToFour: 2_250, fiveToNine: 1_995, tenPlus: 1_750 },
};
const sibling = { ...z10, id: "z11", sku: "EDG-Z11", optionLabel: "60°" };
const z46: CommerceVariant = {
  ...z10,
  id: "z46",
  sku: "EDG-Z46",
  tierPrices: { oneToFour: 3_650, fiveToNine: 3_250, tenPlus: 2_850 },
};
const agreedDelivery: DeliveryQuote = {
  kind: "agreed", serviceName: "Agreed three-day delivery", workingDays: 3, chargeExVatPence: 1_125,
};

function basket(lines: readonly LineRequest[], variants: readonly CommerceVariant[] = [z10, sibling, z46]) {
  return calculateBasket({ variants, lines, deliveryQuote: STANDARD_DELIVERY_QUOTE });
}

function samePriceVariant(id: string, pence: number): CommerceVariant {
  return {
    ...z10,
    id,
    tierPrices: { oneToFour: pence, fiveToNine: pence, tenPlus: pence },
  };
}

describe("all-units quantity pricing", () => {
  it.each([
    [1, 1, 2_250, 2_250, 0],
    [4, 1, 2_250, 9_000, 0],
    [5, 5, 1_995, 9_975, 1_275],
    [9, 5, 1_995, 17_955, 2_295],
    [10, 10, 1_750, 17_500, 5_000],
    [11, 10, 1_750, 19_250, 5_500],
  ])("prices %i Z10s at tier %i with the same rate on every unit", (quantity, tier, unit, net, saving) => {
    expect(priceLine(z10, quantity)).toMatchObject({
      ok: true,
      value: { tierMinimumQuantity: tier, unitNetPence: unit, lineNetPence: net, savingPence: saving },
    });
  });

  it("combines duplicate variant lines before selecting a tier", () => {
    expect(basket([{ variantId: "z10", quantity: 1 }, { variantId: "z10", quantity: 4 }])).toMatchObject({
      ok: true,
      value: { lines: [{ variantId: "z10", quantity: 5, lineNetPence: 9_975 }] },
    });
  });

  it("prices mixed variants independently even when their individual tier prices match", () => {
    expect(basket([{ variantId: "z10", quantity: 4 }, { variantId: "z11", quantity: 1 }])).toMatchObject({
      ok: true,
      value: {
        goodsNetPence: 11_250,
        lines: [{ variantId: "z10", unitNetPence: 2_250 }, { variantId: "z11", unitNetPence: 2_250 }],
      },
    });
  });

  it("compares nine Z10s at £179.55 with ten at £175.00 and prompts to save £4.55 ex VAT", () => {
    expect(basket([{ variantId: "z10", quantity: 4 }, { variantId: "z10", quantity: 5 }])).toMatchObject({
      ok: true,
      value: {
        goodsNetPence: 17_955,
        lines: [{
          savingPrompt: {
            additionalQuantity: 1,
            nextQuantity: 10,
            nextLineNetPence: 17_500,
            netChangePence: -455,
            message: "Add one blade and save £4.55 ex VAT",
          },
        }],
      },
    });
    expect(basket([{ variantId: "z10", quantity: 10 }])).toMatchObject({
      ok: true,
      value: { goodsNetPence: 17_500, lines: [{ savingPrompt: null }] },
    });
  });

  it("does not prompt to add a tenth Z10 when only nine are available", () => {
    expect(priceLine({ ...z10, availableQuantity: 9 }, 9)).toMatchObject({
      ok: true, value: { savingPrompt: null },
    });
  });

  it("can show a catalogue price for an out-of-stock variant without suggesting another unit", () => {
    expect(priceLine({ ...z10, availableQuantity: 0 }, 9)).toMatchObject({
      ok: true, value: { lineNetPence: 17_955, savingPrompt: null },
    });
  });

  it.each([
    [82, "Add one blade for £0.10 more ex VAT"],
    [80, "Add one blade for the same total ex VAT"],
    [83, null],
  ])("checks the 10%% prompt cutoff at a next-tier price of %i pence", (nextPrice, message) => {
    const variant = { ...z10, tierPrices: { oneToFour: 100, fiveToNine: nextPrice, tenPlus: 75 } };
    expect(priceLine(variant, 4)).toMatchObject({
      ok: true, value: { savingPrompt: message ? { message } : null },
    });
  });

  it("can suggest adding multiple blades in one step and never skips a tier", () => {
    const variant = { ...z10, tierPrices: { oneToFour: 100, fiveToNine: 59, tenPlus: 20 } };
    expect(priceLine(variant, 3)).toMatchObject({
      ok: true,
      value: { savingPrompt: { nextQuantity: 5, message: "Add 2 blades and save £0.05 ex VAT" } },
    });
  });
});

describe("basket snapshots and VAT", () => {
  it("prices five Z10s at £99.75 plus £6.95 delivery and £21.34 VAT for a £128.04 gross order", () => {
    expect(basket([{ variantId: "z10", quantity: 5 }])).toEqual({
      ok: true,
      value: {
        currency: "GBP",
        vatRateBasisPoints: 2_000,
        lines: [{
          variantId: "z10",
          sku: "EDG-Z10",
          optionLabel: "50°",
          quantity: 5,
          tierMinimumQuantity: 5,
          unitNetPence: 1_995,
          lineNetPence: 9_975,
          savingPence: 1_275,
          savingPrompt: null,
          lineVatPence: 1_995,
          lineGrossPence: 11_970,
        }],
        goodsNetPence: 9_975,
        goodsVatPence: 1_995,
        goodsGrossPence: 11_970,
        delivery: {
          quote: STANDARD_DELIVERY_QUOTE,
          netPence: 695,
          vatPence: 139,
          grossPence: 834,
          freeDeliveryProgress: { thresholdPence: 15_000, remainingPence: 5_025 },
        },
        totalNetPence: 10_670,
        totalVatPence: 2_134,
        totalGrossPence: 12_804,
      },
    });
  });

  it.each([[14_999, 695, 1], [15_000, 0, 0]])(
    "uses a goods subtotal of %i pence to apply %i pence standard delivery at the threshold",
    (pence, netPence, remainingPence) => {
      expect(basket([{ variantId: "boundary", quantity: 1 }], [samePriceVariant("boundary", pence)])).toMatchObject({
        ok: true,
        value: { delivery: { netPence, freeDeliveryProgress: { thresholdPence: 15_000, remainingPence } } },
      });
    },
  );

  it("checks free delivery after tier discounts and before VAT or delivery are added", () => {
    expect(basket([{ variantId: "z10", quantity: 7 }])).toMatchObject({
      ok: true,
      value: { goodsNetPence: 13_965, delivery: { netPence: 695, freeDeliveryProgress: { remainingPence: 1_035 } } },
    });
  });

  it("rounds VAT per consolidated variant, not per unit, request row, or basket subtotal", () => {
    const variants = [samePriceVariant("a", 3), samePriceVariant("b", 3), samePriceVariant("c", 3)];
    const lines = ["a", "a", "b", "c"].map((variantId) => ({ variantId, quantity: 1 }));
    expect(basket(lines, variants)).toMatchObject({
      ok: true,
      value: {
        goodsNetPence: 12,
        goodsVatPence: 3,
        lines: [
          { variantId: "a", lineNetPence: 6, lineVatPence: 1 },
          { variantId: "b", lineNetPence: 3, lineVatPence: 1 },
          { variantId: "c", lineNetPence: 3, lineVatPence: 1 },
        ],
        totalVatPence: 142,
      },
    });
  });

  it("snapshots and uses the supplied VAT rate on goods and delivery", () => {
    expect(calculateBasket({
      variants: [z10],
      lines: [{ variantId: "z10", quantity: 5 }],
      deliveryQuote: STANDARD_DELIVERY_QUOTE,
      vatRateBasisPoints: 1_750,
    })).toMatchObject({
      ok: true,
      value: { vatRateBasisPoints: 1_750, goodsVatPence: 1_746, delivery: { vatPence: 122 }, totalGrossPence: 12_538 },
    });
  });

  it("keeps an agreed delivery charge and taxes it even when standard delivery would be free", () => {
    expect(calculateBasket({
      variants: [z10],
      lines: [{ variantId: "z10", quantity: 10 }],
      deliveryQuote: agreedDelivery,
    })).toMatchObject({
      ok: true,
      value: { delivery: { quote: agreedDelivery, netPence: 1_125, vatPence: 225, freeDeliveryProgress: null } },
    });
  });

  it("rejects an empty selection instead of producing a payable order snapshot", () => {
    expect(basket([])).toEqual({ ok: false, error: { code: "empty_basket" } });
  });

  it("preserves all total identities across variant quantities, delivery services and tax rates", () => {
    for (const deliveryQuote of [STANDARD_DELIVERY_QUOTE, agreedDelivery]) {
      for (const vatRateBasisPoints of [0, 500, 1_750, 2_000]) {
        for (let first = 0; first <= 12; first++) {
          for (let second = 0; second <= 12; second++) {
            if (first === 0 && second === 0) continue;
            const lines = [
              { variantId: "z10", quantity: first },
              { variantId: "z46", quantity: second },
            ].filter(({ quantity }) => quantity > 0);
            const result = calculateBasket({ variants: [z10, z46], lines, deliveryQuote, vatRateBasisPoints });
            expect(result.ok).toBe(true);
            if (!result.ok) continue;
            const { value: totals } = result;
            for (const line of totals.lines) {
              expect(line.lineNetPence).toBe(line.unitNetPence * line.quantity);
              expect(line.lineVatPence).toBe(Math.floor((line.lineNetPence * vatRateBasisPoints + 5_000) / 10_000));
              expect(line.lineGrossPence).toBe(line.lineNetPence + line.lineVatPence);
            }
            expect(totals.goodsNetPence).toBe(totals.lines.reduce((sum, line) => sum + line.lineNetPence, 0));
            expect(totals.goodsVatPence).toBe(totals.lines.reduce((sum, line) => sum + line.lineVatPence, 0));
            expect(totals.goodsGrossPence).toBe(totals.lines.reduce((sum, line) => sum + line.lineGrossPence, 0));
            expect(totals.delivery.grossPence).toBe(totals.delivery.netPence + totals.delivery.vatPence);
            expect(totals.totalNetPence).toBe(totals.goodsNetPence + totals.delivery.netPence);
            expect(totals.totalVatPence).toBe(totals.goodsVatPence + totals.delivery.vatPence);
            expect(totals.totalGrossPence).toBe(totals.totalNetPence + totals.totalVatPence);
            expect(totals.totalGrossPence).toBe(totals.goodsGrossPence + totals.delivery.grossPence);
          }
        }
      }
    }
  });
});

describe("basket validation", () => {
  it.each([0, -1, 1.25, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid quantity %s", (quantity) => {
    expect(basket([{ variantId: "z10", quantity }])).toEqual({
      ok: false, error: { code: "invalid_quantity", variantId: "z10" },
    });
  });

  it("rejects individual invalid quantities even when their sum would be valid", () => {
    expect(basket([{ variantId: "z10", quantity: 4 }, { variantId: "z10", quantity: -1 }])).toMatchObject({
      ok: false, error: { code: "invalid_quantity" },
    });
  });

  it("rejects an unknown variant instead of treating it as a product or SKU", () => {
    expect(basket([{ variantId: "EDG-Z10", quantity: 1 }])).toEqual({
      ok: false, error: { code: "unknown_variant", variantId: "EDG-Z10" },
    });
  });

  it("rejects ambiguous catalogue records for the same variant ID", () => {
    expect(basket([{ variantId: "z10", quantity: 1 }], [z10, { ...sibling, id: z10.id }])).toEqual({
      ok: false, error: { code: "duplicate_variant", variantId: "z10" },
    });
  });

  it("rejects a stale selection of a sold-out option without blocking its in-stock sibling", () => {
    const variants = [{ ...z10, availableQuantity: 0 }, sibling];
    expect(basket([{ variantId: "z10", quantity: 1 }, { variantId: "z11", quantity: 1 }], variants)).toEqual({
      ok: false,
      error: {
        code: "insufficient_stock",
        shortfalls: [{ variantId: "z10", requestedQuantity: 1, availableQuantity: 0 }],
      },
    });
    expect(basket([{ variantId: "z11", quantity: 1 }], variants)).toMatchObject({
      ok: true, value: { lines: [{ variantId: "z11" }] },
    });
  });

  it("reports every shortfall after aggregating quantities against current availability", () => {
    expect(basket([
      { variantId: "z10", quantity: 3 }, { variantId: "z11", quantity: 2 }, { variantId: "z10", quantity: 3 },
    ], [
      { ...z10, availableQuantity: 5 }, { ...sibling, availableQuantity: 0 },
    ])).toEqual({
      ok: false,
      error: {
        code: "insufficient_stock",
        shortfalls: [
          { variantId: "z10", requestedQuantity: 6, availableQuantity: 5 },
          { variantId: "z11", requestedQuantity: 2, availableQuantity: 0 },
        ],
      },
    });
  });

  it("validates catalogue money and availability", () => {
    expect(priceLine({ ...z10, tierPrices: { ...z10.tierPrices, fiveToNine: 999.5 } }, 1)).toMatchObject({
      ok: false, error: { code: "invalid_tier_prices", variantId: "z10" },
    });
    expect(priceLine({ ...z10, availableQuantity: -1 }, 1)).toMatchObject({
      ok: false, error: { code: "invalid_availability", variantId: "z10" },
    });
  });

  it("rejects unsafe intermediate quantities and line or basket amounts", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(basket([{ variantId: "z10", quantity: max }, { variantId: "z10", quantity: 1 }])).toMatchObject({
      ok: false, error: { code: "invalid_quantity" },
    });
    expect(priceLine(samePriceVariant("max", max), 2)).toEqual({ ok: false, error: { code: "amount_out_of_range" } });
    expect(basket([{ variantId: "max", quantity: 1 }], [samePriceVariant("max", max)])).toEqual({
      ok: false, error: { code: "amount_out_of_range" },
    });
  });

  it("rejects an invalid VAT rate or delivery quote instead of producing totals", () => {
    const input = { variants: [z10], lines: [{ variantId: "z10", quantity: 1 }] };
    expect(calculateBasket({ ...input, deliveryQuote: STANDARD_DELIVERY_QUOTE, vatRateBasisPoints: -1 }))
      .toEqual({ ok: false, error: { code: "invalid_vat_rate" } });
    expect(calculateBasket({
      ...input, deliveryQuote: { ...STANDARD_DELIVERY_QUOTE, chargeExVatPence: 0 },
    })).toEqual({ ok: false, error: { code: "invalid_delivery_quote" } });
  });
});
