"use client";

import { useId, useState } from "react";
import { formatPoundsInput, parsePoundsToPence, POUNDS_INPUT_PATTERN } from "@/lib/admin/pounds";
import { cataloguePriceTiers, tierMargin, type TierPrices } from "@/lib/admin/price-tiers";
import { incVatLabel } from "@/lib/catalogue/display-prices";
import { formatGbp } from "@/lib/commerce/money";

export interface PriceTierFieldsProps {
  prices?: TierPrices;
  required?: boolean;
  landedUnitPence?: number | null;
  readOnly?: boolean;
}

const percent = new Intl.NumberFormat("en-GB", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

function PriceTierField({ band, field, initialPence, required, landedUnitPence, readOnly }: Omit<PriceTierFieldsProps, "prices"> & {
  band: string; field: string; initialPence: number | null | undefined;
}) {
  const id = useId();
  const [pounds, setPounds] = useState(() => formatPoundsInput(initialPence));
  const pence = readOnly ? initialPence : parsePoundsToPence(pounds);
  const margin = pence ? tierMargin(pence, landedUnitPence) : null;

  return <div className="admin-field">
    {readOnly ? <>
      <span>{band}</span>
      <span className="admin-mono">{pence ? `${formatGbp(pence)} ex VAT` : "Not set"}</span>
    </> : <>
      <label htmlFor={id}>{band} (£ ex VAT)</label>
      <input id={id} name={field} inputMode="decimal" value={pounds}
        onChange={(event) => setPounds(event.target.value)}
        pattern={POUNDS_INPUT_PATTERN} placeholder="0.00" required={required}
        aria-describedby={pence ? `${id}-preview` : undefined} />
    </>}
    {pence ? <div id={`${id}-preview`} className="admin-muted">
      <div>{incVatLabel(pence)}</div>
      {margin && <div>Margin ex VAT: {formatGbp(margin.marginPence)} ({percent.format(margin.marginRate)})
        {margin.marginPence < 0 && <> · <strong>Below landed cost</strong></>}
      </div>}
    </div> : null}
  </div>;
}

export function PriceTierFields({ prices, ...props }: PriceTierFieldsProps) {
  return <div className="admin-grid">
    {cataloguePriceTiers.map(({ band, field, key }) => (
      <PriceTierField key={`${key}:${prices?.[key] ?? ""}`} band={band} field={field} initialPence={prices?.[key]} {...props} />
    ))}
  </div>;
}
