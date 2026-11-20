import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineRequest } from "@/lib/commerce";
import {
  captureCheckoutSelection,
  clearConfirmedCheckoutSelection,
  persistSelectionChange,
  rememberCheckoutSelection,
} from "@/app/checkout/success/selection-handoff";

const sessionId = "cs_test_session1";
const scope = createHash("sha256").update(sessionId).digest("hex");
const lines: LineRequest[] = [
  { variantId: "variant-1", quantity: 5 },
  { variantId: "variant-2", quantity: 1 },
];

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  let queue = Promise.resolve<unknown>(undefined);
  vi.stubGlobal("navigator", {
    locks: {
      request: (_key: string, callback: () => unknown) => {
        const next = queue.then(callback);
        queue = next.catch(() => undefined);
        return next;
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

async function markCheckout() {
  await rememberCheckoutSelection(sessionId, await captureCheckoutSelection(lines));
}

describe("checkout selection handoff", () => {
  it("confirms only the bound session and exact paid selection and consumes the marker once", async () => {
    await markCheckout();
    const clear = vi.fn<(matches: (current: readonly LineRequest[]) => boolean) => void>();

    await clearConfirmedCheckoutSelection("different-scope", lines, clear);
    await clearConfirmedCheckoutSelection(scope, lines.slice(0, 1), clear);
    expect(clear).not.toHaveBeenCalled();
    await clearConfirmedCheckoutSelection(scope, [...lines].reverse(), clear);
    await clearConfirmedCheckoutSelection(scope, lines, clear);
    expect(clear).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    const matches = clear.mock.calls[0]![0];
    expect(matches([...lines].reverse())).toBe(true);
    expect(matches(lines.map((line) => ({ ...line, quantity: line.quantity + 1 })))).toBe(false);
    expect(matches([...lines, { variantId: "variant-3", quantity: 1 }])).toBe(false);
  });

  it("protects a selection edited and then rebuilt with identical quantities", async () => {
    await markCheckout();
    const persist = vi.fn();
    persistSelectionChange(persist);
    persistSelectionChange(persist);
    const clear = vi.fn();
    await clearConfirmedCheckoutSelection(scope, lines, clear);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(clear).not.toHaveBeenCalled();
  });

  it("does not let a late response attach a marker to a changed selection", async () => {
    const capture = await captureCheckoutSelection(lines);
    persistSelectionChange(vi.fn());
    await rememberCheckoutSelection(sessionId, capture);
    const clear = vi.fn();
    await clearConfirmedCheckoutSelection(scope, lines, clear);
    expect(clear).not.toHaveBeenCalled();
  });

  it("does not let an older response replace a newer attempt's marker", async () => {
    const older = await captureCheckoutSelection(lines);
    await markCheckout();
    await rememberCheckoutSelection("cs_test_olderAttempt", older);
    const clear = vi.fn();
    await clearConfirmedCheckoutSelection(scope, lines, clear);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("keeps ordinary selection writes but skips cleanup without browser locking", async () => {
    vi.stubGlobal("navigator", {});
    expect(await captureCheckoutSelection(lines)).toBeNull();
    const persist = vi.fn();
    persistSelectionChange(persist);
    expect(persist).toHaveBeenCalledOnce();
    const clear = vi.fn();
    await clearConfirmedCheckoutSelection(scope, lines, clear);
    expect(clear).not.toHaveBeenCalled();
  });
});
