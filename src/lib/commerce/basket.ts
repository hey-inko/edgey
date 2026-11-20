import { priceDelivery, type DeliveryError, type DeliveryQuote, type PricedDelivery } from "./delivery";
import {
  calculateVat,
  isPence,
  STANDARD_VAT_RATE_BASIS_POINTS,
  type CommerceResult,
  type Pence,
  type VatError,
  type VatRateBasisPoints,
} from "./money";
import {
  isPositiveQuantity,
  priceLine,
  type CommerceVariant,
  type LinePricingError,
  type LineRequest,
  type PricedLine,
} from "./pricing";

export type BasketInput = Readonly<{
  variants: readonly CommerceVariant[];
  lines: readonly LineRequest[];
  deliveryQuote: DeliveryQuote;
  vatRateBasisPoints?: VatRateBasisPoints;
}>;

export type BasketLine = PricedLine & { lineVatPence: Pence; lineGrossPence: Pence };
export type BasketDelivery = PricedDelivery & { vatPence: Pence; grossPence: Pence };

export type BasketTotals = {
  currency: "GBP";
  vatRateBasisPoints: VatRateBasisPoints;
  lines: BasketLine[];
  delivery: BasketDelivery;
  goodsNetPence: Pence;
  goodsVatPence: Pence;
  goodsGrossPence: Pence;
  totalNetPence: Pence;
  totalVatPence: Pence;
  totalGrossPence: Pence;
};

export type StockShortfall = {
  variantId: string;
  requestedQuantity: number;
  availableQuantity: number;
};

export type BasketError =
  | LinePricingError
  | DeliveryError
  | VatError
  | { code: "empty_basket" }
  | { code: "unknown_variant"; variantId: string }
  | { code: "duplicate_variant"; variantId: string }
  | { code: "insufficient_stock"; shortfalls: StockShortfall[] };

export function calculateBasket({
  variants,
  lines,
  deliveryQuote,
  vatRateBasisPoints = STANDARD_VAT_RATE_BASIS_POINTS,
}: BasketInput): CommerceResult<BasketTotals, BasketError> {
  if (lines.length === 0) return { ok: false, error: { code: "empty_basket" } };

  const variantsById = new Map<string, CommerceVariant>();
  for (const variant of variants) {
    if (variantsById.has(variant.id)) {
      return { ok: false, error: { code: "duplicate_variant", variantId: variant.id } };
    }
    variantsById.set(variant.id, variant);
  }

  const quantitiesById = new Map<string, { variant: CommerceVariant; quantity: number }>();
  for (const { variantId, quantity } of lines) {
    if (!isPositiveQuantity(quantity)) {
      return { ok: false, error: { code: "invalid_quantity", variantId } };
    }
    const variant = variantsById.get(variantId);
    if (!variant) {
      return { ok: false, error: { code: "unknown_variant", variantId } };
    }
    const combinedQuantity = (quantitiesById.get(variantId)?.quantity ?? 0) + quantity;
    if (!isPositiveQuantity(combinedQuantity)) {
      return { ok: false, error: { code: "invalid_quantity", variantId } };
    }
    quantitiesById.set(variantId, { variant, quantity: combinedQuantity });
  }

  const pricedLines: BasketLine[] = [];
  const shortfalls: StockShortfall[] = [];
  let goodsNetPence = 0;
  let goodsVatPence = 0;
  for (const { variant, quantity } of quantitiesById.values()) {
    const line = priceLine(variant, quantity);
    if (!line.ok) return line;
    if (quantity > variant.availableQuantity) {
      shortfalls.push({
        variantId: variant.id,
        requestedQuantity: quantity,
        availableQuantity: variant.availableQuantity,
      });
      continue;
    }

    const vat = calculateVat(line.value.lineNetPence, vatRateBasisPoints);
    if (!vat.ok) return vat;
    pricedLines.push({
      ...line.value,
      lineVatPence: vat.value,
      lineGrossPence: line.value.lineNetPence + vat.value,
    });
    goodsNetPence += line.value.lineNetPence;
    goodsVatPence += vat.value;
  }
  if (shortfalls.length > 0) return { ok: false, error: { code: "insufficient_stock", shortfalls } };

  if (!isPence(goodsNetPence)) return { ok: false, error: { code: "amount_out_of_range" } };
  const delivery = priceDelivery(goodsNetPence, deliveryQuote);
  if (!delivery.ok) return delivery;
  const deliveryVat = calculateVat(delivery.value.netPence, vatRateBasisPoints);
  if (!deliveryVat.ok) return deliveryVat;

  const totalNetPence = goodsNetPence + delivery.value.netPence;
  const totalVatPence = goodsVatPence + deliveryVat.value;
  const totalGrossPence = totalNetPence + totalVatPence;
  if (!isPence(totalGrossPence)) return { ok: false, error: { code: "amount_out_of_range" } };

  return {
    ok: true,
    value: {
      currency: "GBP",
      vatRateBasisPoints,
      lines: pricedLines,
      delivery: {
        ...delivery.value,
        vatPence: deliveryVat.value,
        grossPence: delivery.value.netPence + deliveryVat.value,
      },
      goodsNetPence,
      goodsVatPence,
      goodsGrossPence: goodsNetPence + goodsVatPence,
      totalNetPence,
      totalVatPence,
      totalGrossPence,
    },
  };
}
