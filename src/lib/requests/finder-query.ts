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

export function finderCodeForFingerprint(query: string): string | undefined {
  if (privateFinderQuery(query) || !/^[a-z0-9][a-z0-9 ._-]{1,30}[a-z0-9]$/i.test(query)) return;
  const words = query.split(/ +/);
  if (words.length > 1 && words.some((word) => /^[a-z]{3,}$/i.test(word))) return;
  const code = normaliseFinderCode(query);
  if (/\d/.test(code)) return code;
}
