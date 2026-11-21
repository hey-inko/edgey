import { expect, test } from "vitest";
import { isStockAdjustmentReason, parseStaffCost, parseStockAdjustmentQuantity } from "../../src/lib/admin/stock-cost";

function fields(values: Record<string, string>) {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}

test("pounds and supplier currency are parsed into exact minor units", () => {
  expect(parseStaffCost(fields({ supplier_unit_minor: "3.05", currency: "USD", landed_unit_pence: " 2.75 ",
    exchange_rate: "0.81234567", freight_unit_pence: "0.1", duty_unit_pence: "0.23", cost_note: " Test note. ",
  }))).toEqual({ ok: true, value: {
    supplier_unit_minor: 305, currency: "USD", landed_unit_pence: 275, exchange_rate: "0.81234567",
    freight_unit_pence: 10, duty_unit_pence: 23, note: "Test note.",
  } });
});

test("an optional receipt cost can be blank, not partial or malformed", () => {
  expect(parseStaffCost(fields({ supplier_unit_minor: " ", currency: "" }), true)).toEqual({ ok: true, value: null });
  expect(parseStaffCost(fields({ supplier_unit_minor: "1" }), true)).toEqual({ ok: false });
  const complete = { supplier_unit_minor: "5", currency: "USD", landed_unit_pence: "3.50" };
  const changes: Record<string, string>[] = [
    { supplier_unit_minor: "1.234" }, { currency: "XAU" }, { landed_unit_pence: "£3" }, { landed_unit_pence: "21474836.48" },
    { freight_unit_pence: "-1" }, { duty_unit_pence: "1e2" }, { exchange_rate: "0" }, { exchange_rate: "0.123456789" },
    { cost_note: "x".repeat(501) },
  ];
  for (const change of changes) expect(parseStaffCost(fields({ ...complete, ...change }))).toEqual({ ok: false });
});

test("adjustments accept signed nonzero stock and a supported reason", () => {
  expect(["-2", "+3", "4"].map(parseStockAdjustmentQuantity)).toEqual([-2, 3, 4]);
  expect(["0", "-0", "+0", "1.5", "2e3", "2147483648", "-2147483648"].map(parseStockAdjustmentQuantity))
    .toEqual(Array(7).fill(null));
  expect(isStockAdjustmentReason("count_correction")).toBe(true);
  expect(isStockAdjustmentReason("prototype")).toBe(false);
});
