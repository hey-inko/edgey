import { isValidDeliveryQuote, STANDARD_DELIVERY_QUOTE, type DeliveryQuote } from "./delivery";
import type { CommerceResult } from "./money";

export type UkPostcode = {
  normalised: string;
  area: string;
  district: string;
};

export type PostcodeError = { code: "invalid_postcode" };
export type CoverageError = PostcodeError | { code: "invalid_delivery_quote" };

export type DeliveryCoverageTable = Readonly<{
  areas: Readonly<Partial<Record<string, DeliveryQuote | null>>>;
  districts?: Readonly<Partial<Record<string, DeliveryQuote | null>>>;
}>;

export type DeliveryCoverage =
  | { kind: "covered"; postcode: UkPostcode; quote: DeliveryQuote }
  | { kind: "enquiry-required"; postcode: UkPostcode };

const ukPostcodePattern = /^(GIR) ?(0AA)$|^([A-PR-UWYZ](?:[0-9](?:[0-9]|[A-HJKPSTUW])?|[A-HK-Y][0-9](?:[0-9]|[ABEHMNPRVWXY])?)) ?([0-9][ABD-HJLNP-UW-Z]{2})$/;

export function parseUkPostcode(input: string): CommerceResult<UkPostcode, PostcodeError> {
  const compact = typeof input === "string" && input.length <= 32 ? input.trim().replace(/\s+/g, " ") : "";
  const parts = /^[a-z0-9 ]+$/i.test(compact) ? ukPostcodePattern.exec(compact.toUpperCase()) : null;
  const district = parts?.[1] ?? parts?.[3];
  const inward = parts?.[2] ?? parts?.[4];
  const area = district?.match(/^[A-Z]+/)?.[0];
  if (!area || !district || !inward) return { ok: false, error: { code: "invalid_postcode" } };

  return { ok: true, value: { normalised: `${district} ${inward}`, area, district } };
}

export function lookupDeliveryCoverage(
  input: string,
  table: DeliveryCoverageTable,
): CommerceResult<DeliveryCoverage, CoverageError> {
  const parsed = parseUkPostcode(input);
  if (!parsed.ok) return parsed;

  const postcode = parsed.value;
  const district = table.districts && Object.prototype.hasOwnProperty.call(table.districts, postcode.district)
    ? table.districts[postcode.district]
    : undefined;
  const quote = district === undefined && Object.prototype.hasOwnProperty.call(table.areas, postcode.area)
    ? table.areas[postcode.area]
    : district;

  if (!quote) return { ok: true, value: { kind: "enquiry-required", postcode } };
  if (!isValidDeliveryQuote(quote)) return { ok: false, error: { code: "invalid_delivery_quote" } };
  return { ok: true, value: { kind: "covered", postcode, quote } };
}

const placeholderMainlandAreas = (
  "AL B BA BB BD BH BL BN BR BS CA CB CF CH CM CO CR CT CV CW DA DD DE DG DH DL DN DT DY E EC EH EN " +
  "EX FY G GL GU HA HD HG HP HR HU HX IG IP KA KT L LA LD LE LL LN LS LU M ME MK ML N NE NG NN NP NR " +
  "NW OL OX PE PL PO PR RG RH RM S SA SE SG SK SL SM SN SO SP SR SS ST SW SY TA TD TF TN TQ TR TS TW " +
  "UB W WA WC WD WF WN WR WS WV YO"
).split(" ");

export const PLACEHOLDER_DELIVERY_COVERAGE: DeliveryCoverageTable = Object.freeze({
  areas: Object.freeze(Object.fromEntries(placeholderMainlandAreas.map((area) => [area, STANDARD_DELIVERY_QUOTE]))),
  districts: Object.freeze({
    KA27: null, KA28: null,
    PO30: null, PO31: null, PO32: null, PO33: null, PO34: null, PO35: null, PO36: null,
    PO37: null, PO38: null, PO39: null, PO40: null, PO41: null,
    TR21: null, TR22: null, TR23: null, TR24: null, TR25: null,
  }),
});
