import { staffSession } from "@/lib/admin/auth";
import { salesCsv } from "@/lib/sales/csv";
import { missingSalesMigration, readSalesReport } from "@/lib/sales/database";
import { parseSalesQuery } from "@/lib/sales/report";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  const staff = await staffSession();
  if (!staff) return new Response("Staff sign-in required.", { status: 403, headers });

  const params = Object.fromEntries(new URL(request.url).searchParams);
  if (params.kind !== "products" && params.kind !== "daily") {
    return new Response("Choose a sales export.", { status: 400, headers });
  }
  const query = parseSalesQuery(params);
  if (!query.range) return new Response(query.error, { status: 400, headers });
  const { data, error } = await readSalesReport(staff.db, query.range, "day");
  if (error?.code === "42501") return new Response("Staff sign-in required.", { status: 403, headers });
  if (missingSalesMigration(error?.code)) return new Response("Sales reporting is not available yet.", { status: 503, headers });
  if (error || !data) return new Response("Could not export sales.", { status: 500, headers });

  const name = `edgey-sales-${params.kind}-${query.range.from}-to-${query.range.to}.csv`;
  return new Response("\uFEFF" + salesCsv(data, params.kind, query), {
    headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
  });
}
