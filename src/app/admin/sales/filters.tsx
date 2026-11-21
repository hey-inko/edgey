"use client";

import { useEffect, useRef, useState } from "react";
import { grains, minSalesDate, periods, type SalesQuery, type SalesPeriod } from "@/lib/sales/report";
import { AdminField } from "../ui";

export default function SalesFilters({ query }: { query: SalesQuery }) {
  const [period, setPeriod] = useState(query.period);
  const error = useRef<HTMLParagraphElement>(null);
  useEffect(() => { error.current?.focus(); }, [query.error]);

  return <form className="admin-panel sales-filters" action="/admin/sales">
    <AdminField label="Period">
      <select name="period" value={period} onChange={(event) => setPeriod(event.target.value as SalesPeriod)}>
        {Object.entries(periods).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </AdminField>
    {period === "custom" && <>
      <AdminField label="From">
        <input name="from" type="date" required min={minSalesDate} max={query.today} defaultValue={query.draft.from}
          aria-invalid={Boolean(query.error)} aria-describedby={query.error ? "sales-range-error" : undefined} />
      </AdminField>
      <AdminField label="To">
        <input name="to" type="date" required min={minSalesDate} max={query.today} defaultValue={query.draft.to}
          aria-invalid={Boolean(query.error)} aria-describedby={query.error ? "sales-range-error" : undefined} />
      </AdminField>
    </>}
    <AdminField label="Show chart by">
      <select name="grain" defaultValue={query.grain}>
        {Object.entries(grains).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </AdminField>
    <input type="hidden" name="sort" value={query.sort} />
    <input type="hidden" name="dir" value={query.dir} />
    <button className="primary" type="submit">Apply</button>
    {query.error && <p className="sales-filter-error" id="sales-range-error" ref={error} tabIndex={-1}>{query.error}</p>}
  </form>;
}
