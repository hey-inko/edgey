export const periods = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
  "last-month": "Last month",
  custom: "Custom range",
} as const;

export const grains = { day: "Day", week: "Week", month: "Month" } as const;
export const productSorts = {
  name: "Product", units: "Units", revenuePence: "Revenue", marginPence: "Margin", shareBps: "Revenue share",
} as const;
export const minSalesDate = "1900-01-01";

export type SalesPeriod = keyof typeof periods;
export type SalesGrain = keyof typeof grains;
export type SalesSort = keyof typeof productSorts;
export type SalesSearch = Record<string, string | string[] | undefined>;
export type DateRange = { from: string; to: string };
export type SalesQuery = {
  period: SalesPeriod; grain: SalesGrain; sort: SalesSort; dir: "asc" | "desc";
  today: string; draft: DateRange;
} & ({ range: DateRange; previous: DateRange; error?: never } | { range: null; error: string });

export type SalesSeries = {
  date: string;
  revenuePence: number;
  vatPence: number;
  deliveryPence: number;
  orders: number;
  units: number;
  refundsPence: number;
  creditsPence: number;
};

export type SalesKpis = Omit<SalesSeries, "date"> & {
  aovPence: number | null; marginPence: number | null; marginBps: number | null;
};

export type SalesProduct = {
  id: string; sku: string; name: string; published: boolean; units: number; revenuePence: number;
  marginPence: number | null; marginBps: number | null; shareBps: number | null;
  available: number; weeklyUnits: number; weeksCover: number | null;
  stockFlag: "low" | "never_sold" | "no_sales" | null;
  costUnknown: boolean | null;
};

export type SalesSplit = { key: string; revenuePence: number; units: number; orders?: number };

export type SalesReport = {
  canSeeMargin: boolean;
  current: SalesKpis;
  previous: SalesKpis;
  daily: SalesSeries[];
  series: SalesSeries[];
  products: SalesProduct[];
  tiers: SalesSplit[];
  payments: SalesSplit[];
  buyers: { new: number; returning: number };
};

const dayMs = 86_400_000;
const number = new Intl.NumberFormat("en-GB");
const london = new Intl.DateTimeFormat("en-CA", {
  year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London",
});
const longDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function dateOnly(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < minSalesDate) return;
  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) return value;
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(date) + days * dayMs).toISOString().slice(0, 10);
}

function option<T extends string>(choices: Record<T, string>, value: unknown, fallback: T): T {
  return typeof value === "string" && Object.hasOwn(choices, value) ? value as T : fallback;
}

export function parseSalesQuery(search: SalesSearch, now = new Date()): SalesQuery {
  const today = london.format(now);
  const period = option<SalesPeriod>(periods, search.period, "30d");
  const grain = option<SalesGrain>(grains, search.grain, "day");
  const sort = option<SalesSort>(productSorts, search.sort, "revenuePence");
  const dir = search.dir === "asc" || search.dir === "desc" ? search.dir : sort === "name" ? "asc" : "desc";
  const monthStart = `${today.slice(0, 7)}-01`;
  const defaultStart = addDays(today, -29);
  const customFrom = dateOnly(search.from);
  const customTo = dateOnly(search.to);
  const draft = { from: customFrom ?? (period === "custom" ? "" : defaultStart), to: customTo ?? (period === "custom" ? "" : today) };
  const query = { period, grain, sort, dir, today, draft } as const;
  let from = defaultStart;
  let to = today;
  switch (period) {
    case "today": from = today; break;
    case "7d": from = addDays(today, -6); break;
    case "month": from = monthStart; break;
    case "last-month":
      to = addDays(monthStart, -1);
      from = `${to.slice(0, 7)}-01`;
      break;
    case "custom":
      if (!customFrom || !customTo || customFrom > customTo || customTo > today) {
        return { ...query, range: null, error: "Enter a valid start and end date, in order and no later than today." };
      }
      from = customFrom;
      to = customTo;
  }
  const days = (Date.parse(to) - Date.parse(from)) / dayMs + 1;
  if (days > 366) return { ...query, range: null, error: "Choose a period of 366 days or less." };
  return { ...query, range: { from, to }, previous: { from: addDays(from, -days), to: addDays(from, -1) } };
}

export function salesParams(query: Pick<SalesQuery, "period" | "draft" | "grain" | "sort" | "dir">) {
  const params = new URLSearchParams({ period: query.period, grain: query.grain, sort: query.sort, dir: query.dir });
  if (query.period === "custom") {
    params.set("from", query.draft.from);
    params.set("to", query.draft.to);
  }
  return params;
}

export function displaySalesDate(date: string, short = false) {
  return (short ? shortDate : longDate).format(new Date(date));
}

export function displaySalesRange({ from, to }: DateRange) {
  return from === to ? displaySalesDate(from) : `${displaySalesDate(from)} – ${displaySalesDate(to)}`;
}

export function decimalHundredths(value: number) {
  const integer = BigInt(value);
  const magnitude = integer < 0n ? -integer : integer;
  return `${integer < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

export function salesMoney(pence: number) {
  const absolute = BigInt(Math.abs(pence));
  return `${pence < 0 ? "-" : ""}£${number.format(absolute / 100n)}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function sortProducts(rows: SalesProduct[], requested: SalesSort, dir: "asc" | "desc", canSeeMargin: boolean) {
  const key = !canSeeMargin && requested === "marginPence" ? "revenuePence" : requested;
  const direction = !canSeeMargin && requested === "marginPence" ? -1 : dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
    } else {
      const comparison = typeof left === "string" ? left.localeCompare(String(right), "en-GB") : left - Number(right);
      if (comparison) return direction * comparison;
    }
    return a.sku.localeCompare(b.sku, "en-GB");
  });
}
