import { AdminField, AdminHeading, AdminLink, AdminNotice, AdminSection, AdminTable } from "@/app/admin/ui";
import { requireStaff } from "@/lib/admin/auth";
import { getWarehouseQueue, type WarehouseView } from "@/lib/admin/warehouse";
import { dispatchDate, movementTime, warehouseLabel, warehouseOrderLookup, warehousePage } from "@/lib/admin/warehouse-format";
import { WarehousePagination } from "./pagination";

const views: Record<WarehouseView, { title: string; empty: string; href: string }> = {
  queue: { title: "Ready to pick and picking", empty: "There are no orders waiting to pick or dispatch.", href: "/admin/warehouse" },
  history: { title: "Dispatch and cancellation history", empty: "There are no dispatched or cancelled orders.", href: "/admin/warehouse?view=history" },
  blocked: { title: "Payment blocks", empty: "There are no orders blocked by a void or full refund.", href: "/admin/warehouse?view=blocked" },
};

export default async function WarehousePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; reference?: string; page?: string }>;
}) {
  const { db } = await requireStaff("warehouse");
  const { view: selected, reference, page: requestedPage } = await searchParams;
  const view = selected === "history" || selected === "blocked" ? selected : "queue";
  const lookup = typeof reference === "string" ? reference.trim().slice(0, 100) : "";
  const parsedLookup = warehouseOrderLookup(lookup);
  const invalid = Boolean(lookup) && !parsedLookup;
  const page = lookup ? 1 : warehousePage(requestedPage);
  const { rows, hasMore } = invalid
    ? { rows: [], hasMore: false }
    : await getWarehouseQueue(db, { view, page, lookup: parsedLookup });

  return (
    <>
      <AdminHeading
        eyebrow="Warehouse"
        title={view === "queue" ? "Pick and dispatch" : views[view].title}
        description="Pick against the order snapshot and record carrier and tracking when the parcel leaves."
      />
      <nav aria-label="Warehouse views" className="flex flex-wrap gap-4">
        {view !== "queue" && <AdminLink href={views.queue.href}>Picking queue</AdminLink>}
        {view !== "history" && <AdminLink href={views.history.href}>Dispatch and cancellation history</AdminLink>}
        {view !== "blocked" && <AdminLink href={views.blocked.href}>Payment blocks</AdminLink>}
      </nav>
      <form action="/admin/warehouse" method="get" className="admin-panel mt-3 flex flex-wrap items-end gap-3">
        {view !== "queue" && <input type="hidden" name="view" value={view} />}
        <AdminField label="Order reference">
          <input className="admin-mono" name="reference" defaultValue={lookup} maxLength={100} required />
        </AdminField>
        <button type="submit" className="admin-secondary">Find order</button>
        {lookup && <AdminLink href={views[view].href}>Clear lookup</AdminLink>}
      </form>
      <AdminSection title={lookup ? "Order lookup" : view === "queue" ? views.queue.title : "Orders"}>
        {!rows.length ? (
          <AdminNotice>{invalid ? "Enter the full order reference." : lookup
            ? "No authorised order matches that reference." : views[view].empty}</AdminNotice>
        ) : (
          <AdminTable
            label={lookup ? "Order lookup" : views[view].title}
            headers={["Order reference", "Recipient", "Service", "Promised dispatch", "Fulfilment", view === "history" && !lookup ? "Dispatched" : "Payment"]}
          >
            {rows.map((order) => (
              <tr key={order.id}>
                <td className="admin-mono break-all"><AdminLink href={`/admin/warehouse/${order.id}`}>{order.order_reference}</AdminLink></td>
                <td>{order.recipient_name}<br />{order.business_name}</td>
                <td>{order.delivery_service}</td>
                <td className="admin-mono"><time dateTime={order.promised_dispatch_date}>{dispatchDate(order.promised_dispatch_date)}</time></td>
                <td>{warehouseLabel(order.fulfilment_status)}</td>
                <td>{view === "history" && !lookup
                  ? order.dispatched_at
                    ? <time dateTime={order.dispatched_at}>{movementTime(order.dispatched_at)}</time>
                    : "Not dispatched"
                  : warehouseLabel(order.payment_status)}</td>
              </tr>
            ))}
          </AdminTable>
        )}
        <WarehousePagination href={views[view].href} page={page} hasMore={hasMore} label="Order pages" />
      </AdminSection>
    </>
  );
}
