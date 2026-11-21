import { parsePoundsToPence } from "./pounds";

export const cataloguePriceTiers = [
  { band: "1–4 blades", field: "price_1_4_gbp", key: "price_1_4_pence" },
  { band: "5–9 blades", field: "price_5_9_gbp", key: "price_5_9_pence" },
  { band: "10+ blades", field: "price_10_plus_gbp", key: "price_10_plus_pence" },
] as const;

type PriceKey = (typeof cataloguePriceTiers)[number]["key"];
export type TierPrices = Record<PriceKey, number | null>;

export const emptyTierPrices: TierPrices = {
  price_1_4_pence: null, price_5_9_pence: null, price_10_plus_pence: null,
};

type TierResult = { ok: true; value: Record<PriceKey, number> | null } | { ok: false; message: string };

export function parseTierPrices(form: Pick<FormData, "get">): TierResult {
  const inputs = cataloguePriceTiers.map(({ field }) => form.get(field));
  if (inputs.includes(null)) return { ok: false, message: "Reload the page and enter the prices in pounds." };
  const blank = (value: FormDataEntryValue | null) => typeof value === "string" && !value.trim();
  if (inputs.every(blank)) return { ok: true, value: null };
  if (inputs.some(blank)) return { ok: false, message: "Enter all three price tiers or leave all three blank on a draft." };

  const [first, middle, last] = inputs.map(parsePoundsToPence);
  if (!first || !middle || !last) {
    return { ok: false, message: "Enter each price in pounds from £0.01 to £21,474,836.47, with up to two decimal places." };
  }
  if (middle > first || last > middle) {
    return { ok: false, message: "The unit price must stay the same or decrease in each higher quantity band." };
  }
  return { ok: true, value: { price_1_4_pence: first, price_5_9_pence: middle, price_10_plus_pence: last } };
}

export function tierMargin(sellPence: number, landedUnitPence: number | null | undefined) {
  if (!Number.isSafeInteger(sellPence) || sellPence <= 0 || landedUnitPence == null
    || !Number.isSafeInteger(landedUnitPence) || landedUnitPence < 0) return null;
  const marginPence = sellPence - landedUnitPence;
  return { marginPence, marginRate: marginPence / sellPence };
}
