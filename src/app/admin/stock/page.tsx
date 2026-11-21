import { AdminHeading, AdminLink, AdminNotice, AdminSection, AdminTable } from "@/app/admin/ui";
import { requireStaff } from "@/lib/admin/auth";
import { getStockList } from "@/lib/admin/warehouse";
import { warehouseLabel, warehousePage } from "@/lib/admin/warehouse-format";
import { WarehousePagination } from "../warehouse/pagination";

export default async function StockPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requireStaff("warehouse");
  const page = warehousePage((await searchParams).page);
  const { rows, hasMore } = await getStockList(page);

  return (
    <>
      <AdminHeading
        title="Stock"
        eyebrow="Warehouse"
        description="Choose a SKU to receive stock, record an adjustment or review its movements. Available stock excludes units held for orders and trials."
      />
      <div><AdminLink href="/admin/warehouse">Picking queue</AdminLink></div>
      <AdminSection title="Variant balances">
        {rows.length ? (
          <AdminTable label="Variant balances" headers={["SKU", "Variant", "Catalogue status", "On hand", "Reserved", "Available"]}>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="admin-mono"><AdminLink href={`/admin/stock/${row.id}`}>{row.sku}</AdminLink></td>
                <td>{row.option_label || row.tool || "Standard variant"}</td>
                <td>{warehouseLabel(row.publication_status)}</td>
                <td className="admin-mono">{row.stock_on_hand}</td>
                <td className="admin-mono">{row.stock_reserved}</td>
                <td className="admin-mono">{row.stock_on_hand - row.stock_reserved}</td>
              </tr>
            ))}
          </AdminTable>
        ) : <AdminNotice>No variants found on this page.</AdminNotice>}
        <WarehousePagination href="/admin/stock" page={page} hasMore={hasMore} label="Stock pages" />
      </AdminSection>
    </>
  );
}
