import { formatGbp, isPence, type CommerceResult, type Pence } from "./money";

export type TierPrices = Readonly<{
  oneToFour: Pence;
  fiveToNine: Pence;
  tenPlus: Pence;
}>;

export type CommerceVariant = Readonly<{
  id: string;
  sku: string;
  optionLabel: string | null;
  tierPrices: TierPrices;
  availableQuantity: number;
}>;

export type LineRequest = Readonly<{ variantId: string; quantity: number }>;

export type SavingPrompt = {
  additionalQuantity: number;
  nextQuantity: number;
  nextLineNetPence: Pence;
  netChangePence: Pence;
  message: string;
};

export type PricedLine = {
  variantId: string;
  sku: string;
  optionLabel: string | null;
  quantity: number;
  tierMinimumQuantity: 1 | 5 | 10;
  unitNetPence: Pence;
  lineNetPence: Pence;
  savingPence: Pence;
  savingPrompt: SavingPrompt | null;
};

export type LinePricingError =
  | { code: "invalid_quantity"; variantId: string }
  | { code: "invalid_tier_prices"; variantId: string }
  | { code: "invalid_availability"; variantId: string }
  | { code: "amount_out_of_range" };

export function isPositiveQuantity(quantity: unknown): quantity is number {
  return typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity > 0;
}

function getSavingPrompt(
  variant: CommerceVariant,
  quantity: number,
  unitNetPence: Pence,
  lineNetPence: Pence,
): SavingPrompt | null {
  const nextQuantity = quantity < 5 ? 5 : 10;
  if (quantity >= nextQuantity || variant.availableQuantity < nextQuantity) return null;

  const nextUnitPrice = nextQuantity === 5 ? variant.tierPrices.fiveToNine : variant.tierPrices.tenPlus;
  const nextLineNetPence = nextQuantity * nextUnitPrice;
  if (!isPence(nextLineNetPence)) return null;
  const netChangePence = nextLineNetPence - lineNetPence;
  if (netChangePence > Math.floor(unitNetPence / 10)) return null;

  const additionalQuantity = nextQuantity - quantity;
  const units = additionalQuantity === 1 ? "one blade" : `${additionalQuantity} blades`;
  const outcome = netChangePence < 0
    ? `and save ${formatGbp(-netChangePence)} ex VAT`
    : netChangePence === 0
      ? "for the same total ex VAT"
      : `for ${formatGbp(netChangePence)} more ex VAT`;

  return {
    additionalQuantity,
    nextQuantity,
    nextLineNetPence,
    netChangePence,
    message: `Add ${units} ${outcome}`,
  };
}

export function priceLine(
  variant: CommerceVariant,
  quantity: number,
): CommerceResult<PricedLine, LinePricingError> {
  const { id: variantId, sku, optionLabel, tierPrices, availableQuantity } = variant;
  if (!isPositiveQuantity(quantity)) return { ok: false, error: { code: "invalid_quantity", variantId } };
  if (!Number.isSafeInteger(availableQuantity) || availableQuantity < 0) {
    return { ok: false, error: { code: "invalid_availability", variantId } };
  }
  const { oneToFour, fiveToNine, tenPlus } = tierPrices;
  if (
    !isPence(oneToFour) || !isPence(fiveToNine) || !isPence(tenPlus) ||
    tenPlus <= 0 || tenPlus > fiveToNine || fiveToNine > oneToFour
  ) {
    return { ok: false, error: { code: "invalid_tier_prices", variantId } };
  }

  const tierMinimumQuantity = quantity >= 10 ? 10 : quantity >= 5 ? 5 : 1;
  const unitNetPence = tierMinimumQuantity === 10 ? tenPlus : tierMinimumQuantity === 5 ? fiveToNine : oneToFour;
  const lineNetPence = quantity * unitNetPence;
  const savingPence = quantity * (oneToFour - unitNetPence);
  if (!isPence(lineNetPence) || !isPence(savingPence)) {
    return { ok: false, error: { code: "amount_out_of_range" } };
  }

  return {
    ok: true,
    value: {
      variantId,
      sku,
      optionLabel,
      quantity,
      tierMinimumQuantity,
      unitNetPence,
      lineNetPence,
      savingPence,
      savingPrompt: getSavingPrompt(variant, quantity, unitNetPence, lineNetPence),
    },
  };
}
