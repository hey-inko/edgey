import { createHash } from "node:crypto";
import {
  calculateBasket,
  calculateDispatchPromise,
  formatGbp,
  lookupDeliveryCoverage,
  PLACEHOLDER_DELIVERY_COVERAGE,
  STANDARD_DELIVERY_QUOTE,
  type BasketTotals,
  type CommerceVariant,
  type DeliveryQuote,
  type LineRequest,
} from "@/lib/commerce";
import type { QuoteResult } from "./types";
import { MAX_ORDER_INTEGER, normaliseLines, readPostcodeInput } from "./validation";

const allowedPhotos = ["drag.webp", "oscillating.webp", "cylinder.webp", "rotary.webp"];
const quoteUnavailable = "We couldn’t check the latest prices and availability. Try again.";

type CheckoutVariant = CommerceVariant & { photo?: unknown };

export type QuoteDependencies = {
  lookup: (ids: string[]) => Promise<readonly CheckoutVariant[]>;
  now: () => Date;
};

export async function quoteSelectionWith(
  input: unknown,
  postcodeInput: unknown,
  { lookup, now }: QuoteDependencies,
): Promise<QuoteResult> {
  const requested = normaliseLines(input);
  if (!requested) return { status: "error", message: "Check that your selection contains valid items and whole quantities." };

  let coverage: Extract<QuoteResult, { status: "ok" }>["coverage"] = "unchecked";
  let postcode: string | undefined;
  let deliveryQuote: DeliveryQuote = STANDARD_DELIVERY_QUOTE;
  const postcodeText = readPostcodeInput(postcodeInput);
  if (postcodeInput !== undefined && postcodeText !== "") {
    const result = lookupDeliveryCoverage(postcodeText ?? "", PLACEHOLDER_DELIVERY_COVERAGE);
    if (!result.ok) {
      if (result.error.code !== "invalid_postcode") return { status: "error", message: quoteUnavailable };
      coverage = "invalid";
    } else {
      postcode = result.value.postcode.normalised;
      coverage = result.value.kind === "covered" ? "covered" : "unsupported";
      if (result.value.kind === "covered") deliveryQuote = result.value.quote;
    }
  }

  const ids = requested.map(({ variantId }) => variantId);
  const requestedIds = new Set(ids);
  const variants = new Map<string, CheckoutVariant>();
  if (ids.length) {
    try {
      for (const row of await lookup(ids)) {
        if (!requestedIds.has(row.id) || variants.has(row.id) ||
            !Number.isSafeInteger(row.availableQuantity) || row.availableQuantity < 0) {
          return { status: "error", message: quoteUnavailable };
        }
        variants.set(row.id, row);
      }
    } catch {
      return { status: "error", message: quoteUnavailable };
    }
  }

  const lines: LineRequest[] = [];
  const corrections: string[] = [];
  const photos: Record<string, string> = {};
  for (const line of requested) {
    const variant = variants.get(line.variantId);
    if (!variant) {
      corrections.push("An unavailable item was removed from your selection.");
      continue;
    }

    const quantity = Math.min(line.quantity, variant.availableQuantity);
    if (quantity === 0) {
      corrections.push(`${variant.sku} is out of stock and was removed from your selection.`);
      continue;
    }
    if (quantity < line.quantity) {
      corrections.push(`${variant.sku}: quantity changed from ${line.quantity} to ${quantity} due to stock availability.`);
    }
    lines.push({ variantId: line.variantId, quantity });
    if (typeof variant.photo === "string" && allowedPhotos.includes(variant.photo)) photos[line.variantId] = variant.photo;
  }

  let basket: BasketTotals | null = null;
  let freeDeliveryMessage: string | null = null;
  let dispatchDate: string | null = null;
  let estimatedDeliveryDate: string | null = null;
  if (lines.length) {
    const calculated = calculateBasket({ lines, deliveryQuote, variants: [...variants.values()] });
    if (!calculated.ok) return { status: "error", message: quoteUnavailable };
    basket = calculated.value;
    if (basket.totalGrossPence > MAX_ORDER_INTEGER) {
      return { status: "error", message: "This selection exceeds the checkout limit. Reduce the quantities and try again." };
    }

    const canEstimateDelivery = coverage === "covered" || coverage === "unchecked";
    const progress = basket.delivery.freeDeliveryProgress;
    if (canEstimateDelivery && progress) {
      freeDeliveryMessage = progress.remainingPence > 0
        ? `${formatGbp(progress.remainingPence)} more ex VAT for free delivery`
        : "Your selection qualifies for free delivery.";
    }

    const instant = now();
    if (Number.isFinite(instant.getTime())) {
      const authorisedAt = instant.toISOString();
      const promise = calculateDispatchPromise({ authorisedAt, deliveryQuote: canEstimateDelivery ? deliveryQuote : undefined });
      if (promise.ok) {
        ({ dispatchDate, estimatedDeliveryDate } = promise.value);
      } else if (canEstimateDelivery && promise.error.code === "calendar_out_of_range" && promise.error.calendar === "delivery") {
        const dispatchOnly = calculateDispatchPromise({ authorisedAt });
        if (dispatchOnly.ok) dispatchDate = dispatchOnly.value.dispatchDate;
      }
    }
  }

  const quoteKey = createHash("sha256").update(JSON.stringify({
    version: 1,
    basket: basket && { ...basket, lines: [...basket.lines].sort((a, b) => a.variantId.localeCompare(b.variantId)) },
    coverage, postcode, dispatchDate, estimatedDeliveryDate,
  })).digest("hex");

  return {
    status: "ok", lines, corrections, basket, freeDeliveryMessage, dispatchDate, estimatedDeliveryDate, coverage,
    ...(postcode && { postcode }),
    ...(Object.keys(photos).length > 0 && { photos }),
    quoteKey,
  };
}
