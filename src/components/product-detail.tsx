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
import { formatPence, PRICE_BREAKS, VAT_RATE_PERCENT, type PriceTiers } from "@/lib/catalogue/display-prices";
import { formatGbp } from "@/lib/commerce";
import { useSelection } from "./selection-provider";
import { formatDispatchDate } from "./selection-summary";
import { useSelectionQuote } from "./use-selection-quote";

const availabilityWords = { in_stock: "In stock", out_of_stock: "Out of stock" } as const;

// The product detail, shared by the dialog and the page at /blades/[slug], in
// one reading order: figure, part code, name, reference, tool fit, materials,
// availability, variant, quantity, total, per-unit price, primary action.
export function ProductDetail({
  family,
  initialSku,
  mode,
  grossBreaks,
}: {
  family: Family;
  initialSku: string | null;
} & ({ mode: "dialog"; grossBreaks?: never } | { mode: "page"; grossBreaks: Record<string, PriceTiers> })) {
  const id = useId();
  const preselected =
    family.variants.find((variant) => variant.sku === initialSku) ??
    (family.variants.length === 1 ? family.variants[0] : undefined);
  const [sku, setSku] = useState(preselected?.sku ?? null);
  const [quantityInput, setQuantityInput] = useState("1");
  const variant = family.variants.find((candidate) => candidate.sku === sku) ?? null;
  const Heading = mode === "dialog" ? "h2" : "h1";
  const { add, open, hydrated } = useSelection();

  function choose(next: Variant) {
    setSku(next.sku);
    window.history.replaceState(null, "", productHref(family.slug, next.sku));
  }

  const materials = (variant ? variant.substrates : familySubstrates(family)).map((substrate) => substrate.name);
  const fit = variant ? variantFit(variant, mode === "dialog") : [];
  const quantity = Number(quantityInput);
  const maxQuantity = 2_147_483_647;
  const validQuantity = Number.isInteger(quantity) && quantity >= 1 && quantity <= maxQuantity;
  const variantId = variant?.id;
  const lines = variantId && validQuantity ? [{ variantId, quantity }] : [];
  const { quote, pending, retry } = useSelectionQuote(lines, lines.length > 0);
  const priced = quote?.status === "ok" ? quote : null;
  const line = priced?.corrections.length ? undefined : priced?.basket?.lines[0];
  const gross = variant && grossBreaks?.[variant.sku];
  const blocked = !variant
    ? "Choose a variant before adding this blade."
    : priced?.corrections.length
      ? priced.corrections.join(" ")
      : !priced && variant.availability === "out_of_stock"
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
          {fit.length > 0 ? " · " + fit.join(" · ") : ""}
        </dd>
        <dt>Materials</dt>
        <dd>{materials.join(", ") || "Ask us"}</dd>
        <dt>Availability</dt>
        <dd>{variant ? (priced ? priced.lines.length ? "In stock" : "Out of stock" : availabilityWords[variant.availability]) : "Choose a variant"}</dd>
        <dt>Dispatch</dt>
        <dd>{priced?.dispatchDate ? formatDispatchDate(priced.dispatchDate) : "Estimate unavailable"}</dd>
        <dt>Estimated delivery</dt>
        <dd>{priced?.estimatedDeliveryDate ? `${formatDispatchDate(priced.estimatedDeliveryDate)} · provisional` : "Check at checkout"}</dd>
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
        <legend><label htmlFor={id + "-qty"}>Quantity</label></legend>
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
          <input
            id={id + "-qty"}
            className="qty-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxQuantity}
            step={1}
            value={quantityInput}
            aria-invalid={!validQuantity || undefined}
            aria-describedby={!validQuantity ? id + "-quantity-error" : undefined}
            onChange={(event) => setQuantityInput(event.target.value)}
          />
        </div>
      </fieldset>}

      <div className="detail-total" aria-live="polite">
        {line && priced?.basket ? (
          <>
            <span><strong>{formatGbp(line.lineNetPence)}</strong> <span className="fine">ex VAT</span></span>
            <span className="fine detail-prices">
              <span>{formatGbp(line.unitNetPence)} each · ex VAT</span>
              <span>{formatGbp(line.lineGrossPence)} inc VAT ({priced.basket.vatRateBasisPoints / 100}%)</span>
            </span>
            {line.savingPence > 0 && <span className="fine">Quantity saving: {formatGbp(line.savingPence)} ex VAT</span>}
            {line.savingPrompt && <span className="fine">{line.savingPrompt.message}</span>}
          </>
        ) : variant && !validQuantity ? (
          <span className="fine" id={id + "-quantity-error"}>Enter a positive whole quantity to see the total.</span>
        ) : pending ? <span className="fine">Checking current price…</span> : null}
      </div>

      <button type="button" className="primary full" disabled={!line || !hydrated}
        aria-describedby={blocked || quote?.status === "error" ? id + "-add-note" : undefined}
        onClick={(event) => {
          if (!line) return;
          add(line.variantId, line.quantity);
          if (mode === "dialog") event.currentTarget.closest("dialog")?.close();
          open(mode === "page" ? event.currentTarget : undefined);
        }}>
        Add to selection
      </button>
      <div role="status">
        {(blocked || quote?.status === "error") && (
          <p className="fine" id={id + "-add-note"}>{quote?.status === "error" ? quote.message : blocked}</p>
        )}
      </div>
      {quote?.status === "error" && <button type="button" className="textlink" onClick={retry}>Retry price</button>}

      {mode === "dialog" && (
        <p className="fine">
          <a className="textlink" href={productHref(family.slug, family.variants.length > 1 ? variant?.sku : null)}>
            Full specification and price <span className="spec-link-end">breaks <ArrowUpRight size={13} aria-hidden="true" /></span>
          </a>
        </p>
      )}

      {variant && gross && (
        <div className="table-scroll" role="region" tabIndex={0} aria-labelledby={id + "-price-breaks"}>
          <table className="data-table breaks">
            <caption id={id + "-price-breaks"}>Price breaks per blade for {variant.sku}</caption>
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
                  <td className="num">{formatPence(gross[priceBreak.tier])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
