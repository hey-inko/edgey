import "server-only";
import type { Database } from "@/lib/supabase/database.types";
import { serviceClient, ServiceConfigurationError } from "@/lib/supabase/service";
import { PaymentConfigurationError } from "./config";

export type Order = Database["public"]["Tables"]["orders"]["Row"];
export type OrderItem = Database["public"]["Tables"]["order_items"]["Row"];
export type ProviderEvent = Database["public"]["Tables"]["provider_events"]["Row"];

export function paymentStore() {
  try {
    return serviceClient();
  } catch (error) {
    if (error instanceof ServiceConfigurationError) throw new PaymentConfigurationError(error.message);
    throw error;
  }
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
