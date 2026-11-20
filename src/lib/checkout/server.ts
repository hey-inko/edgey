import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { prepareCheckoutAttempt } from "./attempt";
import { quoteSelectionWith, type QuoteDependencies } from "./quote";

const lookup: QuoteDependencies["lookup"] = async (ids) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service-role configuration is missing.");

  const db = createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
  const { data, error } = await db.from("variants")
    .select("id,sku,option_label,price_1_4_pence,price_5_9_pence,price_10_plus_pence,stock_on_hand,stock_reserved,products!inner(photo:media->>photo)")
    .eq("publication_status", "published")
    .in("id", ids);
  if (error || !data) {
    const code = error?.code;
    console.error("Checkout variant lookup failed", code && /^[A-Z0-9]{5,10}$/.test(code) ? code : "unknown");
    throw new Error("Checkout variant lookup failed.");
  }

  return data.map((row) => {
    if (!Number.isSafeInteger(row.stock_on_hand) || !Number.isSafeInteger(row.stock_reserved) ||
        row.stock_reserved < 0 || row.stock_reserved > row.stock_on_hand) {
      throw new Error("Checkout stock values are invalid.");
    }
    return {
      id: row.id,
      sku: row.sku,
      optionLabel: row.option_label,
      tierPrices: {
        oneToFour: row.price_1_4_pence,
        fiveToNine: row.price_5_9_pence,
        tenPlus: row.price_10_plus_pence,
      },
      availableQuantity: row.stock_on_hand - row.stock_reserved,
      photo: row.products?.photo,
    };
  });
};

const deps: QuoteDependencies = { lookup, now: () => new Date() };

export function quoteCurrentSelection(lines: unknown, postcode?: unknown) {
  return quoteSelectionWith(lines, postcode, deps);
}

export function startCheckoutAttempt(input: unknown) {
  return prepareCheckoutAttempt(input, deps);
}
