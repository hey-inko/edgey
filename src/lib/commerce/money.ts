export type Pence = number;
export type VatRateBasisPoints = number;

export type CommerceResult<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const STANDARD_VAT_RATE_BASIS_POINTS = 2_000;

const wholePounds = new Intl.NumberFormat("en-GB");

export function isPence(value: unknown): value is Pence {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function formatGbp(pence: Pence): string {
  const absolute = Math.abs(pence);
  const pounds = wholePounds.format(Math.trunc(absolute / 100));
  const pennies = String(absolute % 100).padStart(2, "0");
  return `${pence < 0 ? "-" : ""}£${pounds}.${pennies}`;
}

export function formatUnitPriceExVat(pence: Pence): string {
  return `${formatGbp(pence)} ex VAT / ea`;
}

export type VatError = { code: "invalid_net_pence" } | { code: "invalid_vat_rate" };

export function calculateVat(
  netPence: Pence,
  rateBasisPoints: VatRateBasisPoints = STANDARD_VAT_RATE_BASIS_POINTS,
): CommerceResult<Pence, VatError> {
  if (!isPence(netPence) || netPence < 0) {
    return { ok: false, error: { code: "invalid_net_pence" } };
  }
  if (!Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > 10_000) {
    return { ok: false, error: { code: "invalid_vat_rate" } };
  }

  const vatPence = Number((BigInt(netPence) * BigInt(rateBasisPoints) + BigInt(5_000)) / BigInt(10_000));
  return { ok: true, value: vatPence };
}
