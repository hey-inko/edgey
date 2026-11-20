import type { CheckoutFields } from "./types";

const storageKey = "edgey-checkout-attempt-v1";
let generation = 0;

export function materialValue(name: keyof CheckoutFields, value: string | boolean) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (name === "email") {
    const at = trimmed.lastIndexOf("@");
    return trimmed.slice(0, at + 1) + trimmed.slice(at + 1).toLowerCase();
  }
  if (name === "postcode") return trimmed.replace(/\s+/g, "").toUpperCase();
  return trimmed.normalize("NFC").replace(/\s+/g, " ");
}

function newAttemptToken() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

async function fingerprint(token: string, quoteKey: string, fields: CheckoutFields) {
  const data = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => [name, materialValue(name as keyof CheckoutFields, value)]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([token, quoteKey, data])));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function prepareCheckoutToken(quoteKey: string, fields: CheckoutFields, reusableToken?: string) {
  const version = generation;
  let candidate = reusableToken;
  if (!candidate) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (typeof saved?.token === "string" && saved.quoteKey === quoteKey &&
          saved.fingerprint === await fingerprint(saved.token, quoteKey, fields)) {
        candidate = saved.token;
      }
    } catch {}
  }
  const token = candidate ?? newAttemptToken();
  return {
    token,
    stillCurrent: () => generation === version,
    remember: async () => {
      try {
        const digest = await fingerprint(token, quoteKey, fields);
        if (generation === version) {
          sessionStorage.setItem(storageKey, JSON.stringify({ token, quoteKey, fingerprint: digest }));
        }
      } catch {}
    },
  };
}

export function forgetCheckoutAttempt() {
  generation += 1;
  try {
    sessionStorage.removeItem(storageKey);
  } catch {}
}
