import { displaySalesDate, salesMoney, type SalesGrain, type SalesSeries } from "@/lib/sales/report";
import { AdminTable } from "../ui";

export default function RevenueChart({ rows, grain }: { rows: SalesSeries[]; grain: SalesGrain }) {
  const first = rows[0];
  if (!first) return <p className="admin-notice">No booked revenue in this period.</p>;
  let peak = first;
  for (const row of rows) if (row.revenuePence > peak.revenuePence) peak = row;
  if (peak.revenuePence === 0) return <p className="admin-notice">No booked revenue in this period.</p>;

  const height = 130;
  const ceiling = peak.revenuePence;
  const midpoint = Number(BigInt(ceiling) / 2n);
  const last = rows.at(-1)!;
  const periodLabel = grain === "day" ? "Day" : grain === "week" ? "Week starting" : "Month starting";
  const summary = `Peak revenue was ${salesMoney(ceiling)} ${grain === "day" ? "on" : `in the ${grain} starting`} ${displaySalesDate(peak.date)}.`;

  return <>
    <figure className="sales-chart">
      <div className="sales-chart-axis admin-mono" aria-hidden="true">
        <span>{salesMoney(ceiling)}</span><span>{salesMoney(midpoint)}</span><span>£0</span>
      </div>
      <div className="sales-chart-area">
        <svg role="img" aria-label="Bar chart of booked product revenue excluding VAT" aria-describedby="sales-chart-note"
          viewBox={`0 0 ${rows.length} ${height}`} preserveAspectRatio="none">
          {[0, height / 2, height].map((y) => <line key={y} x1="0" x2={rows.length} y1={y} y2={y}
            vectorEffect="non-scaling-stroke" />)}
          {rows.map((row, index) => {
            const bar = row.revenuePence * height / ceiling;
            return <rect key={row.date} x={index + .12} y={height - bar} width=".76" height={bar} />;
          })}
        </svg>
        <div className="sales-chart-labels admin-mono" aria-hidden="true">
          <span>{displaySalesDate(first.date, true)}</span>
          {rows.length > 1 && <span>{displaySalesDate(last.date, true)}</span>}
        </div>
      </div>
      <p id="sales-chart-note" className="admin-muted">
        {summary} {grain === "week" ? "Weeks start on Monday. " : ""}
        {grain !== "day" && "The first and last bars only include days inside the chosen period."}
      </p>
    </figure>
    <details className="sales-details">
      <summary>Read chart values</summary>
      <AdminTable label="Revenue chart values" headers={[periodLabel, "Revenue ex VAT"]}>
        {rows.map((row) => <tr key={row.date}>
          <th scope="row">{displaySalesDate(row.date)}</th>
          <td className="admin-mono">{salesMoney(row.revenuePence)}</td>
        </tr>)}
      </AdminTable>
    </details>
  </>;
}
