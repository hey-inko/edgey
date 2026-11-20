import { isPence, type CommerceResult, type Pence } from "./money";
import { isPositiveQuantity } from "./pricing";

export const STANDARD_DELIVERY_CHARGE_PENCE = 695;
export const FREE_DELIVERY_THRESHOLD_PENCE = 15_000;

export type DeliveryQuote = Readonly<{
  serviceName: string;
  chargeExVatPence: Pence;
} & (
  | { kind: "next-working-day"; workingDays: 1 }
  | { kind: "agreed"; workingDays: number }
)>;

export const STANDARD_DELIVERY_QUOTE = Object.freeze({
  kind: "next-working-day",
  serviceName: "Next working day",
  workingDays: 1,
  chargeExVatPence: STANDARD_DELIVERY_CHARGE_PENCE,
} satisfies DeliveryQuote);

export type FreeDeliveryProgress = {
  thresholdPence: Pence;
  remainingPence: Pence;
};

export type PricedDelivery = {
  quote: DeliveryQuote;
  netPence: Pence;
  freeDeliveryProgress: FreeDeliveryProgress | null;
};

export type DeliveryError = { code: "invalid_net_pence" } | { code: "invalid_delivery_quote" };

export function isValidDeliveryQuote(quote: DeliveryQuote): boolean {
  return !!quote && typeof quote.serviceName === "string" && quote.serviceName.trim().length > 0 &&
    isPence(quote.chargeExVatPence) && quote.chargeExVatPence >= 0 &&
    (quote.kind === "next-working-day"
      ? quote.workingDays === 1 && quote.chargeExVatPence === STANDARD_DELIVERY_CHARGE_PENCE
      : quote.kind === "agreed" && isPositiveQuantity(quote.workingDays) &&
        quote.workingDays >= 2 && quote.workingDays <= 366);
}

export function priceDelivery(
  goodsNetPence: Pence,
  quote: DeliveryQuote,
): CommerceResult<PricedDelivery, DeliveryError> {
  if (!isPence(goodsNetPence) || goodsNetPence < 0) {
    return { ok: false, error: { code: "invalid_net_pence" } };
  }
  if (!isValidDeliveryQuote(quote)) return { ok: false, error: { code: "invalid_delivery_quote" } };

  const freeDeliveryProgress = quote.kind === "next-working-day" ? {
    thresholdPence: FREE_DELIVERY_THRESHOLD_PENCE,
    remainingPence: Math.max(0, FREE_DELIVERY_THRESHOLD_PENCE - goodsNetPence),
  } : null;
  const { kind, serviceName, chargeExVatPence, workingDays } = quote;

  return {
    ok: true,
    value: {
      quote: {
        serviceName,
        chargeExVatPence,
        ...(kind === "next-working-day" ? { kind, workingDays: 1 } : { kind, workingDays }),
      },
      netPence: freeDeliveryProgress?.remainingPence === 0 ? 0 : chargeExVatPence,
      freeDeliveryProgress,
    },
  };
}
