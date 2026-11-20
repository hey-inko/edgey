"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { LineRequest } from "@/lib/commerce";

const storageKey = "edgey-storefront-selection-v1";
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const empty: LineRequest[] = [];

function restore(): LineRequest[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return empty;
    const quantities = new Map<string, number>();
    for (const [id, quantity] of Object.entries(stored)) {
      if (uuid.test(id) && Number.isInteger(quantity) && quantity > 0 && quantity <= 2_147_483_647) {
        quantities.set(id.toLowerCase(), quantity);
        if (quantities.size === 100) break;
      }
    }
    return [...quantities].map(([variantId, quantity]) => ({ variantId, quantity }));
  } catch {
    return empty;
  }
}

type Selection = {
  lines: LineRequest[];
  hydrated: boolean;
  revision: number;
  replace: (lines: LineRequest[]) => void;
  setQuantity: (variantId: string, quantity: number) => void;
  add: (variantId: string, quantity: number) => void;
  open: (from?: HTMLElement) => void;
  opened: { from?: HTMLElement } | null;
  close: () => void;
};

const SelectionContext = createContext<Selection | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<{ lines: LineRequest[]; revision: number }>();
  const current = useRef(stored);
  const [opened, setOpened] = useState<Selection["opened"]>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const restored = { lines: restore(), revision: 0 };
      current.current = restored;
      setStored(restored);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  function replace(lines: LineRequest[]) {
    const now = current.current;
    if (!now || (now.lines.length === lines.length && now.lines.every((line, index) =>
      line.variantId === lines[index]?.variantId && line.quantity === lines[index]?.quantity
    ))) return;
    const next = { lines, revision: now.revision + 1 };
    current.current = next;
    setStored(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(lines.map(({ variantId, quantity }) => [variantId, quantity]))));
    } catch {}
  }

  function setQuantity(variantId: string, quantity: number) {
    const lines = current.current?.lines ?? empty;
    if (quantity === 0) replace(lines.filter((line) => line.variantId !== variantId));
    else if (lines.some((line) => line.variantId === variantId)) {
      replace(lines.map((line) => line.variantId === variantId ? { variantId, quantity } : line));
    } else replace([...lines, { variantId, quantity }]);
  }

  return (
    <SelectionContext.Provider value={{
      lines: stored?.lines ?? empty,
      hydrated: !!stored,
      revision: stored?.revision ?? 0,
      replace,
      setQuantity,
      add: (variantId, quantity) => {
        const previous = current.current?.lines.find((line) => line.variantId === variantId)?.quantity ?? 0;
        setQuantity(variantId, Math.min(2_147_483_647, previous + quantity));
      },
      opened,
      open: (from) => setOpened({ from }),
      close: () => setOpened(null),
    }}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection() {
  const selection = useContext(SelectionContext);
  if (!selection) throw new Error("Selection requires its provider.");
  return selection;
}
