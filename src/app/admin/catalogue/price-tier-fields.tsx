import "server-only";

import { cataloguePriceTiers, type TierPrices } from "@/lib/admin/price-tiers";
import { PriceTierField } from "./price-tier-field";

export interface PriceTierFieldsProps {
  prices?: TierPrices;
  required?: boolean;
  landedUnitPence?: number | null;
  readOnly?: boolean;
}

export function PriceTierFields({ prices, required, landedUnitPence, readOnly }: PriceTierFieldsProps) {
  return <div className="admin-grid">
    {cataloguePriceTiers.map(({ band, field, key }) => (
      <PriceTierField key={`${key}:${prices?.[key] ?? ""}`} band={band} field={field} initialPence={prices?.[key]}
        required={required} landedUnitPence={landedUnitPence} readOnly={readOnly} />
    ))}
  </div>;
}
