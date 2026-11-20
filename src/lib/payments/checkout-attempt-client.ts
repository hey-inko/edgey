const key = "edgey-active-payment-v1";

export type ActivePayment = { token: string; sessionId?: string; previousToken?: string };

export function readActivePayment(): ActivePayment | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return value && typeof value.token === "string" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.token) ? value : null;
  } catch {
    return null;
  }
}

export function storeActivePayment(value: ActivePayment | null) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {}
}

export async function clearConfirmedActivePayment(scope: string) {
  try {
    const active = readActivePayment();
    if (!active?.sessionId) return;
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(active.sessionId));
    const hash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const current = readActivePayment();
    if (scope === hash && current?.token === active.token && current.sessionId === active.sessionId) storeActivePayment(null);
  } catch {}
}
