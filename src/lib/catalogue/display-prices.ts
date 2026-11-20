// Prices are integer pence excluding VAT (PRD section 3).
export const VAT_RATE_PERCENT = 20;

export type PriceTiers = { oneToFour: number; fiveToNine: number; tenPlus: number };

export const PRICE_BREAKS = [
  { label: "1–4", from: 1, tier: "oneToFour" },
  { label: "5–9", from: 5, tier: "fiveToNine" },
  { label: "10+", from: 10, tier: "tenPlus" },
] as const;

// All-units pricing: the tier reached applies to every blade on the line.
export function unitPricePence(prices: PriceTiers, quantity: number): number {
  if (quantity >= 10) return prices.tenPlus;
  if (quantity >= 5) return prices.fiveToNine;
  return prices.oneToFour;
}

// VAT on a net amount, rounded half up to the penny.
export function vatPence(netPence: number): number {
  return Math.floor((netPence * VAT_RATE_PERCENT + 50) / 100);
}

export function withVatPence(netPence: number): number {
  return netPence + vatPence(netPence);
}

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

export function formatPence(pence: number): string {
  return gbp.format(pence / 100);
}

export function incVatLabel(netPence: number): string {
  return formatPence(withVatPence(netPence)) + " inc VAT (" + VAT_RATE_PERCENT + "%)";
}
