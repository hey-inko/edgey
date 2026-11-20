import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { requiredEnv } from "./config";

export type Order = Database["public"]["Tables"]["orders"]["Row"];
export type OrderItem = Database["public"]["Tables"]["order_items"]["Row"];
export type ProviderEvent = Database["public"]["Tables"]["provider_events"]["Row"];

let client: SupabaseClient<Database> | undefined;

export function paymentStore() {
  return client ??= createClient<Database>(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
    },
  );
}

export async function getOrder(orderId: string) {
  const { data, error } = await paymentStore().from("orders").select("*").eq("id", orderId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function getOrderItems(orderId: string) {
  const { data, error } = await paymentStore().from("order_items").select("*")
    .eq("order_id", orderId).order("variant_id");
  if (error) throw error;
  return data;
}
