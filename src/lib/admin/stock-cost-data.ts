import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { StaffRole } from "./auth";

type StaffDb = SupabaseClient<Database>;

export function canManageCosts(roles: StaffRole[]) {
  return roles.includes("catalogue") || roles.includes("finance");
}

export function stockSchemaUnavailable(error: { code: string }) {
  return ["42703", "42P01", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(error.code);
}

export async function getCurrentStaffCost(db: StaffDb, roles: StaffRole[], variantId: string) {
  if (!canManageCosts(roles)) return { available: false, cost: null };
  const { data, error } = await db.from("staff_current_variant_costs")
    .select("source, stock_movement_id, supplier_unit_minor, currency, landed_unit_pence, exchange_rate, freight_unit_pence, duty_unit_pence, note, recorded_at")
    .eq("variant_id", variantId).maybeSingle();
  if (error && !stockSchemaUnavailable(error)) throw new Error("Could not load the variant cost.");
  return { available: !error, cost: data };
}

export async function getStaffReceiptCosts(db: StaffDb, roles: StaffRole[], variantId: string, movementIds: number[]) {
  if (!canManageCosts(roles) || !movementIds.length) return [];
  const { data, error } = await db.from("staff_receipt_costs")
    .select("stock_movement_id, supplier_unit_minor, currency, landed_unit_pence")
    .eq("variant_id", variantId).in("stock_movement_id", movementIds);
  if (error && !stockSchemaUnavailable(error)) throw new Error("Could not load receipt costs.");
  return data ?? [];
}
