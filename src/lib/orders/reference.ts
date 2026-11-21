const checkAlphabet = "23456789ABCDEFGHJKLMNPQRSTVWXYZ";

export function normaliseOrderReference(input: string): string | null {
  const reference = input.trim().toUpperCase();
  if (/^EDG-[0-9]{8}$/.test(reference)) return reference;
  const match = /^EDG-([2-9A-HJ-NP-TV-Z]{4})-([2-9A-HJ-NP-TV-Z]{4})-([2-9A-HJ-NP-TV-Z]{4})([2-9A-HJ-NP-TV-Z])$/.exec(reference);
  if (!match) return null;
  const total = [...(match[1]! + match[2]! + match[3]!)].reduce((sum, digit, index) => sum + checkAlphabet.indexOf(digit) * (1 + index % 2), 0);
  return checkAlphabet[total % 31] === match[4] ? reference : null;
}
