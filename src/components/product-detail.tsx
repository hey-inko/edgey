"use client";

import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import { useId, useState } from "react";
import {
  familySubstrates,
  productHref,
  variantFit,
  variantLabel,
  variantReference,
  type Family,
  type Variant,
} from "@/lib/catalogue";
import { formatPence, incVatLabel, PRICE_BREAKS, unitPricePence, VAT_RATE_PERCENT, withVatPence } from "@/lib/catalogue/display-prices";

const availabilityWords = { in_stock: "In stock", out_of_stock: "Out of stock" } as const;

// The product detail, shared by the dialog and the page at /blades/[slug], in
// one reading order: figure, part code, name, reference, tool fit, materials,
// availability, variant, quantity, total, per-unit price, primary action.
export function ProductDetail({
  family,
  initialSku,
  mode,
}: {
  family: Family;
  initialSku: string | null;
  mode: "dialog" | "page";
}) {
  const id = useId();
  const preselected =
    family.variants.find((variant) => variant.sku === initialSku) ??
    (family.variants.length === 1 ? family.variants[0] : undefined);
  const [sku, setSku] = useState(preselected?.sku ?? null);
  const [quantityInput, setQuantityInput] = useState("1");
  const variant = family.variants.find((candidate) => candidate.sku === sku) ?? null;
  const Heading = mode === "dialog" ? "h2" : "h1";

  function choose(next: Variant) {
    setSku(next.sku);
    window.history.replaceState(null, "", productHref(family.slug, next.sku));
  }

  const materials = (variant ? variant.substrates : familySubstrates(family)).map((substrate) => substrate.name);
  const lowest = Math.min(...family.variants.map((candidate) => candidate.prices.oneToFour));
  const quantity = Number(quantityInput);
  const maxUnit = Math.max(...family.variants.map((candidate) => candidate.prices.oneToFour));
  const maxQuantity = Math.floor(Number.MAX_SAFE_INTEGER / (maxUnit * 100));
  const validQuantity = Number.isInteger(quantity) && quantity >= 1 && quantity <= maxQuantity;
  const unit = variant && validQuantity ? unitPricePence(variant.prices, quantity) : null;
  const total = unit === null ? null : unit * quantity;
  const blocked = !variant
    ? "Choose a variant before adding this blade."
    : variant.availability === "out_of_stock"
      ? "This variant is out of stock and cannot be added."
      : null;

  return (
    <>
      {mode === "dialog" &&
        (family.media.photo ? (
          <Image
            className="dialog-img"
            src={"/photos/" + family.media.photo}
            alt={"Illustrative " + family.name.toLowerCase()}
            width={450}
            height={175}
            unoptimized
          />
        ) : (
          <div className="dialog-plate">
            <span className="plate-code">{family.familyCode}</span>
          </div>
        ))}
      <p className="eyebrow">{variant?.sku ?? family.familyCode}</p>
      <Heading id={mode === "dialog" ? "detail-title" : undefined}>{family.name}</Heading>
      <dl className="specs">
        <dt>OEM / reference</dt>
        <dd>
          {variant
            ? (variantReference(variant) ?? "No verified reference yet")
            : [...new Set(family.variants.map(variantReference).filter(Boolean))].join(" · ") || "No verified reference yet"}
        </dd>
        <dt>Tool fit</dt>
        <dd>
          {family.toolType.name}
          {variant && variantFit(variant).length > 0 ? " · " + variantFit(variant).join(" · ") : ""}
        </dd>
        <dt>Materials</dt>
        <dd>{materials.join(", ") || "Ask us"}</dd>
        <dt>Availability</dt>
        <dd>{variant ? availabilityWords[variant.availability] : "Choose a variant"}</dd>
      </dl>

      {family.variants.length > 1 && (
        <fieldset className="quantity-set">
          <legend>Variant</legend>
          <div className="qty-options">
            {family.variants.map((candidate) => (
              <button
                key={candidate.sku}
                type="button"
                aria-pressed={candidate.sku === sku}
                disabled={candidate.availability === "out_of_stock"}
                onClick={() => choose(candidate)}
              >
                {variantLabel(candidate)}
                {candidate.availability === "out_of_stock" && " · Out of stock"}
              </button>
            ))}
          </div>
          {!variant && (
            <p className="choice-note" role="status">Choose the configuration that matches your holder.</p>
          )}
        </fieldset>
      )}

      {variant && <fieldset className="quantity-set">
        <legend>Quantity</legend>
        <div className="qty-row">
          <div className="qty-options">
            {PRICE_BREAKS.map((priceBreak) => (
              <button
                key={priceBreak.from}
                type="button"
                aria-pressed={quantity === priceBreak.from}
                onClick={() => setQuantityInput(String(priceBreak.from))}
              >
                {priceBreak.from}
              </button>
            ))}
          </div>
          <label className="field-label" htmlFor={id + "-qty"}>
            Other <span className="sr">quantity</span>
          </label>
          <input
            id={id + "-qty"}
            className="qty-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxQuantity}
            step={1}
            value={quantityInput}
            aria-invalid={quantityInput !== "" && !validQuantity ? true : undefined}
            onChange={(event) => setQuantityInput(event.target.value)}
          />
        </div>
      </fieldset>}

      <div className="detail-total" aria-live="polite">
        {total !== null && unit !== null ? (
          <>
            <span><strong>{formatPence(total)}</strong> <span className="fine">ex VAT</span></span>
            <span className="fine detail-prices">
              <span>{formatPence(unit)} each · ex VAT</span>
              <span>{incVatLabel(total)}</span>
            </span>
          </>
        ) : variant ? (
          <span className="fine">Enter a positive whole quantity to see the total.</span>
        ) : (
          <>
            <span><strong>From {formatPence(lowest)}</strong> <span className="fine">ex VAT / ea</span></span>
            <span className="fine detail-prices">
              <span>{incVatLabel(lowest)}</span>
            </span>
          </>
        )}
      </div>

      <button type="button" className="primary full" disabled aria-describedby={id + "-add-note"}>
        Add to selection
      </button>
      <p className="fine" id={id + "-add-note"}>
        {blocked ?? "Adding blades to a selection is not available yet."}
      </p>

      {mode === "dialog" && (
        <p className="fine">
          <a className="textlink" href={productHref(family.slug, family.variants.length > 1 ? variant?.sku : null)}>
            Full specification and price breaks <ArrowUpRight size={13} aria-hidden="true" className="inline" />
          </a>
        </p>
      )}

      {mode === "page" && variant && (
        <div className="table-scroll">
          <table className="data-table breaks">
            <caption>Price breaks per blade for {variant.sku}</caption>
            <thead>
              <tr>
                <th scope="col">Quantity</th>
                <th scope="col" className="num">
                  ex VAT
                </th>
                <th scope="col" className="num">
                  inc VAT ({VAT_RATE_PERCENT}%)
                </th>
              </tr>
            </thead>
            <tbody>
              {PRICE_BREAKS.map((priceBreak) => (
                <tr key={priceBreak.from}>
                  <th scope="row">{priceBreak.label} blades</th>
                  <td className="num">{formatPence(variant.prices[priceBreak.tier])}</td>
                  <td className="num">{formatPence(withVatPence(variant.prices[priceBreak.tier]))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
