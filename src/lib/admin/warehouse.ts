import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/database.types";
import { type WarehouseOrderLookup, warehousePageSize } from "./warehouse-format";

type StaffDb = SupabaseClient<Database>;
export type WarehouseView = "queue" | "history" | "blocked";

const queueColumns = "id,order_reference,business_name,recipient_name,delivery_service,promised_dispatch_date,fulfilment_status,payment_status,dispatched_at";
const orderColumns = "id,order_reference,business_name,recipient_name,address_line1,address_line2,address_town,address_region,address_postcode,address_country,delivery_service,promised_dispatch_date,estimated_delivery_date,fulfilment_status,payment_status,dispatched_at,carrier,tracking_number";
const itemColumns = "variant_id,sku,option_label,quantity";
const stockColumns = "id,sku,option_label,tool,publication_status,stock_on_hand,stock_reserved";

export type WarehouseOrder = Pick<Database["public"]["Tables"]["orders"]["Row"],
  "id" | "order_reference" | "business_name" | "recipient_name" | "address_line1" | "address_line2" |
  "address_town" | "address_region" | "address_postcode" | "address_country" |
  "delivery_service" | "promised_dispatch_date" | "estimated_delivery_date" | "fulfilment_status" |
  "payment_status" | "dispatched_at" | "carrier" | "tracking_number"
>;

export type WarehouseItem = Pick<Database["public"]["Tables"]["order_items"]["Row"],
  "variant_id" | "sku" | "option_label" | "quantity"
>;

export async function getWarehouseQueue(
  db: StaffDb,
  { view, page, lookup }: { view: WarehouseView; page: number; lookup: WarehouseOrderLookup | null },
) {
  const first = (page - 1) * warehousePageSize;
  let query = db.from("orders").select(queueColumns).not("authorised_at", "is", null);

  if (lookup) {
    query = query.eq(lookup.field, lookup.value);
  } else if (view === "history") {
    query = query.in("fulfilment_status", ["dispatched", "cancelled"])
      .order("updated_at", { ascending: false });
  } else {
    query = query.in("fulfilment_status", ["ready_to_pick", "picking"]);
    query = view === "blocked"
      ? query.in("payment_status", ["refunded", "voided"])
      : query.not("payment_status", "in", "(refunded,voided)");
    query = query.order("promised_dispatch_date").order("authorised_at");
  }

  const { data, error } = await query.order("id").range(first, first + warehousePageSize);
  if (error) throw error;
  return { rows: data.slice(0, warehousePageSize), hasMore: data.length > warehousePageSize };
}

export async function countWarehousePaymentBlocks(db: StaffDb) {
  const { count, error } = await db.from("orders").select("id", { count: "exact", head: true })
    .not("authorised_at", "is", null).in("fulfilment_status", ["ready_to_pick", "picking"])
    .in("payment_status", ["refunded", "voided"]);
  if (error) throw error;
  return count ?? 0;
}

export async function getWarehouseOrder(db: StaffDb, orderId: string) {
  const { data, error } = await db.from("orders").select(orderColumns)
    .eq("id", orderId).not("authorised_at", "is", null).maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { data: items, error: itemError } = await db.from("order_items").select(itemColumns)
    .eq("order_id", orderId).order("sku").order("variant_id");
  if (itemError) throw itemError;
  return { order: data, items };
}

export async function getWarehouseReturns(db: StaffDb, orderId: string) {
  const { data, error } = await db.from("order_returns")
    .select("id,variant_id,quantity,restored_quantity,reason,lookup_code,created_at")
    .eq("order_id", orderId).order("created_at", { ascending: false }).order("id");
  if (error) throw error;
  return data;
}

export async function getStockList(page: number) {
  const first = (page - 1) * warehousePageSize;
  const { data, error } = await serviceClient().from("variants").select(stockColumns)
    .order("sku").range(first, first + warehousePageSize);
  if (error) throw error;
  return { rows: data.slice(0, warehousePageSize), hasMore: data.length > warehousePageSize };
}

export async function getStockVariant(db: StaffDb, variantId: string, page: number) {
  const { data: variant, error } = await serviceClient().from("variants").select(stockColumns)
    .eq("id", variantId).maybeSingle();
  if (error) throw error;
  if (!variant) return null;

  const first = (page - 1) * warehousePageSize;
  const { data, error: movementError } = await db.from("stock_movements")
    .select("id,kind,on_hand_delta,reserved_delta,created_at,order_id,return_id,trial_request_id")
    .eq("variant_id", variantId).order("created_at", { ascending: false })
    .order("id", { ascending: false }).range(first, first + warehousePageSize);
  if (movementError) throw movementError;
  return { variant, movements: data.slice(0, warehousePageSize), hasMore: data.length > warehousePageSize };
}
