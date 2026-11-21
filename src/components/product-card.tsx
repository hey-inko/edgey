import Image from "next/image";
import Link from "next/link";
import { familyBrands, variantFit, type CatalogueCard } from "@/lib/catalogue";
import { formatPence, incVatLabel } from "@/lib/catalogue/display-prices";

// One card per family: neutral plate, diagonal proof crop, line drawing.
// A family without approved artwork shows its part code on the plain plate.
export function ProductCard({ card }: { card: CatalogueCard }) {
  const { family, match, variants, matchedCode } = card;
  const media = variants[0]?.media ?? family.media;
  const lowest = Math.min(...variants.map((variant) => variant.prices.oneToFour));
  const priceVaries = variants.some((variant) => variant.prices.oneToFour !== lowest);
  const fit = fitLine(card);

  return (
    <Link
      className="p-card"
      href={card.href}
      scroll={false}
      data-proof={media.drawing ? media.proof : undefined}
    >
      <span className="p-card-image">
        {media.drawing ? (
          <Image alt="" src={"/line-art/" + media.drawing} width={388} height={200} unoptimized />
        ) : (
          <span className="plate-code" aria-hidden="true">{family.familyCode}</span>
        )}
      </span>
      <span className="p-card-info">
        {match && (
          <span className="p-card-match">
            {match === "exact" ? "Exact match" : "Suggested"}
            {matchedCode && <> · <span className="printed-code">{matchedCode}</span></>}
          </span>
        )}
        <span className="p-card-code">{family.familyCode}</span>
        <span className="p-card-name">{family.name}</span>
        {match && fit && <span className="p-card-fit">{fit}</span>}
        <span className="p-card-foot">
          <span>
            {priceVaries && "From "}
            <b>{formatPence(lowest)}</b> ex VAT / ea
            <span className="p-card-vat">{incVatLabel(lowest)}</span>
          </span>
          <span className="open-icon" aria-hidden="true" />
        </span>
      </span>
    </Link>
  );
}

// Machine, holder, angle or shank: what tells similar results apart.
function fitLine({ family, variants, match }: CatalogueCard): string {
  const brands = familyBrands({ ...family, variants }).map((brand) => brand.name);
  const machines = variants.flatMap((variant) => variant.compatibility.map((record) => record.machine)).filter(Boolean);
  const options = variants.map((variant) => [variant.optionLabel, ...variantFit(variant)].filter(Boolean))
    .map((parts) => [...new Set(parts)].slice(0, 3).join(" · ")).filter(Boolean);
  const unique = [...new Set(options)];
  const parts = [
    [...new Set([...brands, ...machines])].join(", "),
    match === "exact" && variants.length > 1
      ? variants.length + " configurations" + (unique.length ? ": " + unique.join(" or ") : "")
      : unique.join(" or "),
  ];
  return parts.filter(Boolean).join(" · ");
}
