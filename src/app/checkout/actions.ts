"use server";

import { quoteCurrentSelection, startCheckoutAttempt } from "@/lib/checkout/server";
import type { CheckoutReviewResult, QuoteResult } from "@/lib/checkout/types";

export async function quoteSelection(lines: unknown, postcode?: unknown): Promise<QuoteResult> {
  return quoteCurrentSelection(lines, postcode);
}

export async function checkoutReview(input: unknown): Promise<CheckoutReviewResult> {
  const result = await startCheckoutAttempt(input);
  return result.status === "ready" ? { status: "payment-unavailable" } : result;
}
