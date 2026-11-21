import { decimalHundredths, sortProducts, type SalesQuery, type SalesReport } from "./report";

type Cell = string | number | null | { hundredths: number };

function field(value: Cell) {
  if (value === null) return "";
  if (typeof value === "object") return decimalHundredths(value.hundredths);
  if (typeof value === "number") return String(value);
  const safe = /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function decimal(value: number | null) {
  return value === null ? null : { hundredths: value };
}

function csv(rows: Cell[][]) {
  return rows.map((row) => row.map(field).join(",")).join("\r\n") + "\r\n";
}

export function salesCsv(report: SalesReport, kind: "products" | "daily", { sort, dir }: Pick<SalesQuery, "sort" | "dir">) {
  if (kind === "daily") return csv([
    ["Date (Europe/London)", "Revenue ex VAT (GBP)", "VAT (GBP)", "Delivery ex VAT (GBP)", "Orders", "Units",
      "Refunds incl VAT (GBP)", "Net 30 credits and voids incl VAT (GBP)"],
    ...report.daily.map((row) => [
      row.date, decimal(row.revenuePence), decimal(row.vatPence), decimal(row.deliveryPence), row.orders, row.units,
      decimal(row.refundsPence), decimal(row.creditsPence),
    ]),
  ]);

  const { canSeeMargin } = report;
  return csv([
    ["SKU", "Product", "Units", "Revenue ex VAT (GBP)",
      ...(canSeeMargin ? ["Gross margin (GBP)", "Gross margin (%)", "Cost status"] : []), "Revenue share (%)"],
    ...sortProducts(report.products, sort, dir, canSeeMargin).map((row) => [
      row.sku, row.name, row.units, decimal(row.revenuePence),
      ...(canSeeMargin ? [
        decimal(row.marginPence), decimal(row.marginBps),
        row.costUnknown ? "Cost missing" : row.units ? "Cost available" : "No sales",
      ] : []), decimal(row.shareBps),
    ]),
  ]);
}
