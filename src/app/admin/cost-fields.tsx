import { formatPoundsInput, POUNDS_INPUT_PATTERN } from "@/lib/admin/pounds";
import { supplierCurrencies } from "@/lib/admin/stock-cost";
import { AdminField } from "./ui";

type CostValues = {
  supplier_unit_minor: number | null;
  currency: string | null;
  landed_unit_pence: number | null;
  exchange_rate: number | null;
  freight_unit_pence: number | null;
  duty_unit_pence: number | null;
  note: string | null;
};

export function CostFields({ cost, optional = false }: { cost?: CostValues | null; optional?: boolean }) {
  const amountPattern = optional ? undefined : POUNDS_INPUT_PATTERN;
  return (
    <>
      <p className="admin-muted">Enter amounts per blade, for example 3.50. Landed cost is the all-in cost in pounds, including freight and duty where applicable.</p>
      <div className="admin-grid">
        <AdminField label="Supplier unit price">
          <input name="supplier_unit_minor" inputMode="decimal" maxLength={11} pattern={amountPattern}
            defaultValue={formatPoundsInput(cost?.supplier_unit_minor)} required={!optional} />
        </AdminField>
        <div className="admin-field">
          <label htmlFor="staff-cost-currency">Supplier currency</label>
          <select id="staff-cost-currency" name="currency" defaultValue={cost?.currency ?? ""} required={!optional}>
            <option value="">Choose a currency</option>
            {supplierCurrencies.map((currency) => <option key={currency}>{currency}</option>)}
          </select>
        </div>
        <AdminField label="Landed unit cost (£)">
          <input name="landed_unit_pence" inputMode="decimal" maxLength={11} pattern={amountPattern}
            defaultValue={formatPoundsInput(cost?.landed_unit_pence)} required={!optional} />
        </AdminField>
        <AdminField label="Exchange rate (GBP per supplier currency unit, optional)">
          <input name="exchange_rate" inputMode="decimal" maxLength={16}
            defaultValue={cost?.exchange_rate == null ? "" : cost.exchange_rate.toFixed(8).replace(/\.?0+$/, "")} />
        </AdminField>
        <AdminField label="Freight per blade (£, optional)">
          <input name="freight_unit_pence" inputMode="decimal" maxLength={11} pattern={amountPattern}
            defaultValue={formatPoundsInput(cost?.freight_unit_pence)} />
        </AdminField>
        <AdminField label="Duty per blade (£, optional)">
          <input name="duty_unit_pence" inputMode="decimal" maxLength={11} pattern={amountPattern}
            defaultValue={formatPoundsInput(cost?.duty_unit_pence)} />
        </AdminField>
      </div>
      <AdminField label="Cost note (optional; no supplier or contact details)">
        <textarea name="cost_note" rows={2} maxLength={500} defaultValue={cost?.note ?? ""} />
      </AdminField>
    </>
  );
}
