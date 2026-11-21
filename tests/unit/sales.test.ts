import { describe, expect, it } from "vitest";
import { salesCsv } from "@/lib/sales/csv";
import { parseSalesQuery, salesMoney, type SalesProduct, type SalesReport } from "@/lib/sales/report";

describe("sales reporting filters", () => {
  const now = new Date("2026-04-01T23:10:00Z");

  it("resolves presets and their equal calendar-day comparisons in London", () => {
    for (const [period, from, to, priorFrom, priorTo] of [
      ["today", "2026-04-02", "2026-04-02", "2026-04-01", "2026-04-01"],
      ["7d", "2026-03-27", "2026-04-02", "2026-03-20", "2026-03-26"],
      ["30d", "2026-03-04", "2026-04-02", "2026-02-02", "2026-03-03"],
      ["month", "2026-04-01", "2026-04-02", "2026-03-30", "2026-03-31"],
      ["last-month", "2026-03-01", "2026-03-31", "2026-01-29", "2026-02-28"],
    ]) {
      expect(parseSalesQuery({ period }, now)).toMatchObject({
        range: { from, to }, previous: { from: priorFrom, to: priorTo },
      });
    }
  });

  it("accepts an inclusive leap-year range and rejects invalid, future, ambiguous or oversized ranges", () => {
    expect(parseSalesQuery({ period: "custom", from: "2024-01-01", to: "2024-12-31" }, now).range)
      .toEqual({ from: "2024-01-01", to: "2024-12-31" });
    for (const [from, to] of [
      ["2024-01-01", "2025-01-01"], ["2025-02-29", "2025-03-01"], ["2026-04-03", "2026-04-03"],
      ["2026-04-02", "2026-04-01"], ["1899-12-31", "1900-01-01"], [["2026-04-01", "2026-04-02"], "2026-04-02"],
    ]) {
      expect(parseSalesQuery({ period: "custom", from, to }, now)).toMatchObject({ range: null, error: expect.any(String) });
    }
    expect(parseSalesQuery({ period: "constructor", sort: "__proto__", grain: "toString" }, now))
      .toMatchObject({ period: "30d", sort: "revenuePence", grain: "day" });
  });
});

describe("sales CSV", () => {
  const product: SalesProduct = {
    id: "1", sku: "@A", name: '  =HYPERLINK("x")', published: true, units: 2, revenuePence: 2001,
    marginPence: -119, marginBps: -595, shareBps: 10000, available: 3, weeklyUnits: 0.5,
    weeksCover: 6, stockFlag: null, costUnknown: false,
  };
  const day = {
    date: "2026-04-01", revenuePence: 2001, vatPence: 539, deliveryPence: 695, orders: 1, units: 2,
    refundsPence: 100, creditsPence: 0,
  };
  const totals = { ...day, aovPence: 2001, marginPence: -119, marginBps: -595 };
  const report: SalesReport = {
    canSeeMargin: true, products: [
      { ...product, id: "2", sku: "B", name: "Unknown", marginPence: null, marginBps: null, costUnknown: true },
      product,
    ], daily: [day], series: [{ ...day, date: "2026-03-30" }], current: totals, previous: totals,
    tiers: [], payments: [], buyers: { new: 1, returning: 0 },
  };

  it("uses numeric decimals, quotes catalogue text safely and leaves missing margins blank and last", () => {
    const csv = salesCsv(report, "products", { sort: "marginPence", dir: "asc" });
    expect(csv.split("\r\n")).toEqual([
      '"SKU","Product","Units","Revenue ex VAT (GBP)","Gross margin (GBP)","Gross margin (%)","Cost status","Revenue share (%)"',
      `"'@A","'  =HYPERLINK(""x"")",2,20.01,-1.19,-5.95,"Cost available",100.00`,
      '"B","Unknown",2,20.01,,,"Cost missing",100.00',
      "",
    ]);
    expect(salesMoney(-9_007_199_254_740_991)).toBe("-£90,071,992,547,409.91");
  });

  it("has no cost columns for other staff and exports daily values regardless of chart grain", () => {
    const noCosts = salesCsv({ ...report, canSeeMargin: false }, "products", { sort: "marginPence", dir: "asc" });
    expect(noCosts).not.toMatch(/margin|cost|-1\.19/i);
    const daily = salesCsv(report, "daily", { sort: "name", dir: "asc" });
    expect(daily).toContain('"2026-04-01",20.01,5.39,6.95,1,2,1.00,0.00\r\n');
    expect(daily).not.toContain("2026-03-30");
  });
});
