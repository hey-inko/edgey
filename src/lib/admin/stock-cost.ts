import { parsePoundsToPence } from "./pounds";

export const supplierCurrencies = ["GBP", "USD", "EUR"] as const;

export const stockAdjustmentReasons = {
  damaged: "Damaged",
  lost: "Lost",
  sample_given: "Sample given",
  count_correction: "Count correction",
  returned_to_supplier: "Returned to supplier",
  other: "Other",
} as const;

export type StockAdjustmentReason = keyof typeof stockAdjustmentReasons;

export function isStockAdjustmentReason(reason: string): reason is StockAdjustmentReason {
  return Object.hasOwn(stockAdjustmentReasons, reason);
}

export function parseStockAdjustmentQuantity(value: string) {
  if (!/^[+-]?\d{1,10}$/.test(value)) return null;
  const quantity = Number(value);
  return quantity !== 0 && Math.abs(quantity) <= 2_147_483_647 ? quantity : null;
}

export function parseStaffCost(form: FormData, optional = false) {
  const names = ["supplier_unit_minor", "currency", "landed_unit_pence", "exchange_rate", "freight_unit_pence",
    "duty_unit_pence", "cost_note"] as const;
  const values = names.map((name) => form.get(name) ?? "");
  if (!values.every((value) => typeof value === "string")) return { ok: false } as const;
  const [supplier, currency, landed, rate, freight, duty, note] = values.map((value) => value.trim());
  if (optional && ![supplier, currency, landed, rate, freight, duty, note].some(Boolean)) return { ok: true, value: null } as const;

  const supplierUnit = parsePoundsToPence(supplier);
  const landedUnit = parsePoundsToPence(landed);
  const freightUnit = freight ? parsePoundsToPence(freight) : null;
  const dutyUnit = duty ? parsePoundsToPence(duty) : null;
  const supplierCurrency = supplierCurrencies.find((code) => code === currency);
  if (!supplierCurrency || supplierUnit === null || landedUnit === null ||
      (freight && freightUnit === null) || (duty && dutyUnit === null) ||
      (rate && (!/^\d{1,7}(?:\.\d{1,8})?$/.test(rate) || Number(rate) <= 0 || Number(rate) > 1_000_000)) ||
      (note?.length ?? 0) > 500) {
    return { ok: false } as const;
  }
  return { ok: true, value: {
    supplier_unit_minor: supplierUnit,
    currency: supplierCurrency,
    landed_unit_pence: landedUnit,
    exchange_rate: rate || null,
    freight_unit_pence: freightUnit,
    duty_unit_pence: dutyUnit,
    note: note || null,
  } } as const;
}

export function formatSupplierCost(minor: number, currency: string) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, currencyDisplay: "code" }).format(minor / 100);
}
