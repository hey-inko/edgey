import type { QuoteResult } from "@/lib/checkout/types";

type HistoricalLine = {
  variant_id: string;
  sku: string;
  option_label: string;
  quantity: number;
  unit_price_pence: number;
};

export function compareReorder(previous: readonly HistoricalLine[], quote: Extract<QuoteResult, { status: "ok" }>) {
  const priced = new Map(quote.basket?.lines.map((line) => [line.variantId, line]));
  return {
    lines: quote.lines,
    goodsNetPence: quote.basket?.goodsNetPence ?? 0,
    items: previous.map((line) => {
      const current = priced.get(line.variant_id);
      return {
        id: line.variant_id,
        sku: line.sku,
        optionLabel: line.option_label,
        previousQuantity: line.quantity,
        previousUnitPence: line.unit_price_pence,
        current: current ? {
          sku: current.sku,
          optionLabel: current.optionLabel,
          quantity: current.quantity,
          unitPence: current.unitNetPence,
          totalPence: current.lineNetPence,
        } : null,
      };
    }),
  };
}

export type ReorderReview =
  | { status: "error"; message: string }
  | { status: "ok"; review: ReturnType<typeof compareReorder> };
