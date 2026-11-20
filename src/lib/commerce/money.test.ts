import { describe, expect, it } from "vitest";
import { calculateVat, formatGbp, formatUnitPriceExVat, isPence, priceDelivery, STANDARD_DELIVERY_QUOTE } from "./index";

describe("integer pence", () => {
  it("formats the ex VAT price per blade and the quantity total as shown in the design", () => {
    expect(formatUnitPriceExVat(2_250)).toBe("£22.50 ex VAT / ea");
    expect(formatGbp(9_975)).toBe("£99.75");
    expect(formatGbp(0)).toBe("£0.00");
    expect(formatGbp(-455)).toBe("-£4.55");
    expect(formatGbp(Number.MAX_SAFE_INTEGER)).toBe("£90,071,992,547,409.91");
  });

  it.each([1.2, Infinity, NaN, "2250", Number.MAX_SAFE_INTEGER + 1])("does not treat %s as integer pence", (value) => {
    expect(isPence(value)).toBe(false);
  });

  it("rounds exclusive VAT half up at the penny boundary", () => {
    expect(calculateVat(9, 500)).toEqual({ ok: true, value: 0 });
    expect(calculateVat(10, 500)).toEqual({ ok: true, value: 1 });
    expect(calculateVat(30, 500)).toEqual({ ok: true, value: 2 });
    expect(calculateVat(Number.MAX_SAFE_INTEGER, 10_000)).toEqual({
      ok: true, value: Number.MAX_SAFE_INTEGER,
    });
  });

  it.each([1.1, -1, NaN, Infinity])("rejects invalid net money (%s)", (pence) => {
    expect(calculateVat(pence)).toEqual({ ok: false, error: { code: "invalid_net_pence" } });
    expect(priceDelivery(pence, STANDARD_DELIVERY_QUOTE)).toEqual({ ok: false, error: { code: "invalid_net_pence" } });
  });

  it.each([-1, 1.5, 10_001])("rejects an invalid VAT rate of %i basis points", (rate) => {
    expect(calculateVat(100, rate)).toEqual({ ok: false, error: { code: "invalid_vat_rate" } });
  });
});
