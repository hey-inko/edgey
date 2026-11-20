import { notFound } from "next/navigation";
import { AdminHeading, AdminLink, AdminNotice } from "@/app/admin/ui";
import { requireStaff } from "@/lib/admin/auth";
import { getWarehouseOrder } from "@/lib/admin/warehouse";
import { isWarehouseId, warehouseLabel } from "@/lib/admin/warehouse-format";
import { PickDetails } from "../pick-details";
import { PrintButton } from "./print-button";
import "./print.css";

export default async function WarehousePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { db } = await requireStaff("warehouse");
  const { id } = await params;
  if (!isWarehouseId(id)) notFound();
  const result = await getWarehouseOrder(db, id);
  if (!result) notFound();

  const { order, items } = result;
  const printable = (order.fulfilment_status === "ready_to_pick" || order.fulfilment_status === "picking") &&
    order.payment_status !== "voided" && order.payment_status !== "refunded";

  return (
    <>
      <nav className="mt-4 flex flex-wrap items-center gap-4" aria-label="Pick list controls">
        <AdminLink href={`/admin/warehouse/${order.id}`}>Back to order</AdminLink>
        {printable && <PrintButton />}
      </nav>
      {printable ? (
        <article className="warehouse-pick-list">
          <AdminHeading title="Pick list" eyebrow="Warehouse" />
          <dl className="admin-spec">
            <dt>Order reference</dt><dd className="admin-mono break-all">{order.id}</dd>
            <dt>Fulfilment</dt><dd>{warehouseLabel(order.fulfilment_status)}</dd>
          </dl>
          <PickDetails order={order} items={items} />
        </article>
      ) : <AdminNotice>This order is not eligible for picking. Return to the order for its current status.</AdminNotice>}
    </>
  );
}
