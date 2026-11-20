import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { AdminField, AdminForm, AdminHeading, AdminLink, AdminNotice, AdminSection, AdminTable } from "@/app/admin/ui";
import { requireStaff } from "@/lib/admin/auth";
import { getStockVariant } from "@/lib/admin/warehouse";
import { runWarehouseAction } from "@/lib/admin/warehouse-actions";
import { isWarehouseId, movementTime, warehouseLabel, warehousePage } from "@/lib/admin/warehouse-format";
import { WarehousePagination } from "../../warehouse/pagination";

function delta(value: number) {
  return value > 0 ? `+${value}` : value;
}

export default async function StockVariantPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { db } = await requireStaff("warehouse");
  const { id } = await params;
  if (!isWarehouseId(id)) notFound();
  const page = warehousePage((await searchParams).page);
  const result = await getStockVariant(db, id, page);
  if (!result) notFound();
  const { variant, movements, hasMore } = result;

  return (
    <>
      <AdminHeading title={variant.sku} eyebrow="Stock variant" description={variant.option_label || variant.tool || undefined} />
      <div><AdminLink href="/admin/stock">All variant balances</AdminLink></div>
      <AdminSection title="Current balance">
        <dl className="admin-spec">
          <dt>On hand</dt><dd className="admin-mono">{variant.stock_on_hand}</dd>
          <dt>Reserved</dt><dd className="admin-mono">{variant.stock_reserved}</dd>
          <dt>Available</dt><dd className="admin-mono">{variant.stock_on_hand - variant.stock_reserved}</dd>
          <dt>Catalogue status</dt><dd>{warehouseLabel(variant.publication_status)}</dd>
        </dl>
      </AdminSection>
      <AdminSection title="Receive stock">
        <AdminForm action={runWarehouseAction.bind(null, { kind: "receive", variantId: variant.id, key: randomUUID() })} submit="Record stock receipt">
          <p>Record the physical units received for this variant.</p>
          <AdminField label="Received quantity">
            <input name="quantity" type="number" min={1} max={2_147_483_647} step={1} required />
          </AdminField>
        </AdminForm>
      </AdminSection>
      <AdminSection title="Movement ledger">
        {movements.length ? (
          <AdminTable label="Movement ledger" headers={["Recorded", "Movement", "On-hand change", "Reserved change", "Order reference"]}>
            {movements.map((entry) => (
              <tr key={entry.id}>
                <td className="admin-mono"><time dateTime={entry.created_at}>{movementTime(entry.created_at)}</time></td>
                <td>{warehouseLabel(entry.kind)}</td>
                <td className="admin-mono">{delta(entry.on_hand_delta)}</td>
                <td className="admin-mono">{delta(entry.reserved_delta)}</td>
                <td className="admin-mono break-all">{entry.order_id ?? "—"}</td>
              </tr>
            ))}
          </AdminTable>
        ) : <AdminNotice>No stock movements found on this page.</AdminNotice>}
        <WarehousePagination href={`/admin/stock/${variant.id}`} page={page} hasMore={hasMore} label="Movement pages" />
      </AdminSection>
    </>
  );
}
