import type { LineRequest } from "@/lib/commerce";

const markerKey = "edgey-storefront-checkout-selection-v1";
const lockName = "edgey-storefront-selection";

type CheckoutSelectionCapture = { nonce: string; snapshot: string };
type SelectionPredicate = (lines: readonly LineRequest[]) => boolean;

function selectionSnapshot(lines: readonly LineRequest[]) {
  return JSON.stringify(lines.map(({ variantId, quantity }) => [variantId, quantity] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
}

async function withSelectionLock<T>(callback: () => T): Promise<T | undefined> {
  try {
    return await navigator.locks?.request(lockName, callback);
  } catch {
    return undefined;
  }
}

export function persistSelectionChange(write: () => void) {
  function persist() {
    try {
      localStorage.removeItem(markerKey);
      write();
    } catch {}
  }
  if (navigator.locks) void withSelectionLock(persist);
  else persist();
}

export async function captureCheckoutSelection(lines: readonly LineRequest[]): Promise<CheckoutSelectionCapture | null> {
  return await withSelectionLock(() => {
    const capture = { nonce: crypto.randomUUID(), snapshot: selectionSnapshot(lines) };
    localStorage.setItem(markerKey, capture.nonce);
    return capture;
  }) ?? null;
}

export async function rememberCheckoutSelection(sessionId: string, capture: CheckoutSelectionCapture | null) {
  if (!capture) return;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
    const scope = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    await withSelectionLock(() => {
      if (localStorage.getItem(markerKey) === capture.nonce) {
        localStorage.setItem(markerKey, JSON.stringify([scope, capture.snapshot]));
      }
    });
  } catch {}
}

export async function clearConfirmedCheckoutSelection(
  scope: string,
  paidLines: readonly LineRequest[],
  clearIf: (matches: SelectionPredicate) => void,
) {
  if (paidLines.length === 0) return;
  const snapshot = selectionSnapshot(paidLines);
  await withSelectionLock(() => {
    if (localStorage.getItem(markerKey) !== JSON.stringify([scope, snapshot])) return;
    clearIf((lines) => selectionSnapshot(lines) === snapshot);
    localStorage.removeItem(markerKey);
  });
}
