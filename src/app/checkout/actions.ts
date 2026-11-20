"use server";

import { quoteCurrentSelection } from "@/lib/checkout/server";
import type { QuoteResult } from "@/lib/checkout/types";

export async function quoteSelection(lines: unknown, postcode?: unknown): Promise<QuoteResult> {
  return quoteCurrentSelection(lines, postcode);
}
