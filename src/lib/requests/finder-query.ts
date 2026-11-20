import { parseUkPostcode } from "@/lib/commerce/coverage";

export function normaliseFinderCode(code: string): string {
  return code.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export function normaliseFinderWords(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[\s\p{Pd}]+/gu, " ").trim();
}

export function privateFinderQuery(query: string): boolean {
  return /@|:\/\/|\bwww\./i.test(query)
    || /^[+()\d .-]{9,}$/.test(query) && query.replace(/\D/g, "").length >= 9
    || parseUkPostcode(query).ok;
}
