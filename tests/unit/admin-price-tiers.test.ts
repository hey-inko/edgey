import { describe, expect, it } from "vitest";
import { formatPoundsInput, parsePoundsToPence } from "@/lib/admin/pounds";
import { cataloguePriceTiers, parseTierPrices, tierMargin } from "@/lib/admin/price-tiers";

describe("admin pounds fields", () => {
  it.each([
    ["0", 0], ["1", 100], ["0.01", 1], ["20.9", 2_090], ["20.95", 2_095],
    [" 18.50 ", 1_850], ["21474836.47", 2_147_483_647],
  ])("parses %j to %i pence exactly", (input, pence) => {
    expect(parsePoundsToPence(input)).toBe(pence);
    expect(parsePoundsToPence(formatPoundsInput(pence))).toBe(pence);
  });

  it.each([
    "", " ", "£20.95", "1,500.00", "21,50", "21.501", "21.", "1e2", "0x10", "-1", "+1",
    "21474836.48", "100000000", "1 2", null, 21.5, new Blob(["21.50"]),
  ])("rejects %j", (input) => {
    expect(parsePoundsToPence(input)).toBeNull();
  });

  it("formats ungrouped, two-decimal defaults and preserves blank values", () => {
    expect(formatPoundsInput(2147483647)).toBe("21474836.47");
    expect(formatPoundsInput(0)).toBe("0.00");
    expect(formatPoundsInput(2150)).toBe("21.50");
    expect(formatPoundsInput(null)).toBe("");
    expect(formatPoundsInput(undefined)).toBe("");
  });
});

function tiers(...values: string[]) {
  const data = new FormData();
  values.forEach((value, index) => data.set(cataloguePriceTiers[index]!.field, value));
  return parseTierPrices(data);
}

describe("catalogue price tiers", () => {
  it("distinguishes wholly blank drafts from partial tier sets", () => {
    expect(tiers("", " ", "")).toEqual({ ok: true, value: null });
    expect(tiers("20.95", "", "")).toEqual({
      ok: false, message: "Enter all three price tiers or leave all three blank on a draft.",
    });
  });

  it("does not treat absent GBP fields from a stale form as cleared prices", () => {
    expect(tiers()).toEqual({ ok: false, message: "Reload the page and enter the prices in pounds." });
  });

  it("stores all-unit tiers in pence and permits equal prices", () => {
    expect(tiers("20.95", "18.5", "15.95")).toEqual({
      ok: true, value: { price_1_4_pence: 2_095, price_5_9_pence: 1_850, price_10_plus_pence: 1_595 },
    });
    expect(tiers("1", "1.0", "1.00")).toMatchObject({ ok: true });
  });

  it.each([
    ["20.95", "21", "15.95"], ["20.95", "18.50", "19"], ["20.95", "18.50", "0"],
    ["20.95", "18.001", "15.95"], ["21474836.48", "18.50", "15.95"],
  ])("rejects invalid or ascending prices %j, %j, %j", (...prices) => {
    expect(tiers(...prices)).toMatchObject({ ok: false });
  });
});

describe("ex-VAT tier margin", () => {
  it("uses selling price, not cost, as the percentage denominator", () => {
    expect(tierMargin(2_000, 500)).toEqual({ marginPence: 1_500, marginRate: 0.75 });
    expect(tierMargin(2_000, 2_000)).toEqual({ marginPence: 0, marginRate: 0 });
    expect(tierMargin(2_000, 2_500)).toEqual({ marginPence: -500, marginRate: -0.25 });
  });

  it("does not invent a margin when the selling price or cost is unavailable", () => {
    expect(tierMargin(2_000, null)).toBeNull();
    expect(tierMargin(2_000, undefined)).toBeNull();
    expect(tierMargin(0, 500)).toBeNull();
    expect(tierMargin(2_000, -1)).toBeNull();
  });
});
