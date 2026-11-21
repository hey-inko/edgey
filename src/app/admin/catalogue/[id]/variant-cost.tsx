import { AdminForm, AdminNotice, AdminSection } from "@/app/admin/ui";
import { CostFields } from "@/app/admin/cost-fields";
import { displayTimestamp } from "@/lib/admin/format";
import { formatSupplierCost } from "@/lib/admin/stock-cost";
import type { getCurrentStaffCost } from "@/lib/admin/stock-cost-data";
import { formatGbp } from "@/lib/commerce/money";
import { saveVariantCost } from "./cost-actions";

export function VariantCost({ id, result }: { id: string; result: Awaited<ReturnType<typeof getCurrentStaffCost>> }) {
  const { available, cost } = result;
  const actual = cost?.source === "receipt";
  return (
    <AdminSection title="Supplier cost">
      {!available ? <AdminNotice>Supplier costs will be available after the database update.</AdminNotice> : (
        <>
          {cost?.landed_unit_pence == null || cost.supplier_unit_minor == null || !cost.currency
            ? <AdminNotice>No cost recorded. Set an estimate or add a cost when receiving stock.</AdminNotice>
            : (
              <dl className="admin-spec">
                <dt>Cost source</dt><dd>{actual ? "Latest costed receipt" : "Variant estimate"}</dd>
                <dt>Supplier price per blade</dt><dd className="admin-mono">{formatSupplierCost(cost.supplier_unit_minor, cost.currency)}</dd>
                <dt>Landed cost per blade</dt><dd className="admin-mono">{formatGbp(cost.landed_unit_pence)}</dd>
                <dt>Recorded</dt><dd><time dateTime={cost.recorded_at}>{displayTimestamp(cost.recorded_at)}</time></dd>
                {cost.stock_movement_id != null && <><dt>Stock receipt</dt><dd className="admin-mono">#{cost.stock_movement_id}</dd></>}
                {cost.exchange_rate != null && <><dt>Exchange rate</dt><dd className="admin-mono">{cost.exchange_rate} GBP per {cost.currency}</dd></>}
                {cost.freight_unit_pence != null && <><dt>Freight per blade</dt><dd className="admin-mono">{formatGbp(cost.freight_unit_pence)}</dd></>}
                {cost.duty_unit_pence != null && <><dt>Duty per blade</dt><dd className="admin-mono">{formatGbp(cost.duty_unit_pence)}</dd></>}
                {cost.note && <><dt>Cost note</dt><dd>{cost.note}</dd></>}
              </dl>
            )}
          {actual ? <p className="admin-muted">Margins use this receipt’s landed cost. A receipt without a cost does not replace it.</p> : (
            <AdminForm action={saveVariantCost.bind(null, id)} submit="Save cost estimate">
              <p className="admin-muted">Margins use this estimate until you record a costed receipt.</p>
              <CostFields key={cost?.recorded_at ?? "new-estimate"} cost={cost} />
            </AdminForm>
          )}
        </>
      )}
    </AdminSection>
  );
}
