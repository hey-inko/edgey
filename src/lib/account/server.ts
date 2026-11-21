import "server-only";

import { cache } from "react";
import { getVerifiedBuyer, sessionClient } from "@/lib/auth/server";

const orderSummary = "id,order_reference,created_at,payment_status,fulfilment_status,gross_pence";
const ordersPerPage = 20;
const orderId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const listBuyerOrders = cache(async (page: number) => {
  const buyer = await getVerifiedBuyer();
  if (!buyer) return null;
  const from = (page - 1) * ordersPerPage;
  const { data, error } = await (await sessionClient()).from("orders")
    .select(orderSummary).eq("buyer_id", buyer.id)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(from, from + ordersPerPage);
  if (error) throw new Error("Order history is unavailable.");
  return { orders: data.slice(0, ordersPerPage), hasOlder: data.length > ordersPerPage };
});

export const getBuyerOrder = cache(async (id: string) => {
  const buyer = await getVerifiedBuyer();
  if (!buyer || !orderId.test(id)) return null;
  const { data, error } = await (await sessionClient()).from("orders").select(
    `${orderSummary},goods_net_pence,delivery_net_pence,vat_pence,business_name,recipient_name,payment_method,po_number,
    address_line1,address_line2,address_town,address_region,address_postcode,
    delivery_service,promised_dispatch_date,estimated_delivery_date,dispatched_at,carrier,tracking_number,
    order_items(variant_id,sku,option_label,quantity,unit_price_pence,net_pence,gross_pence)`,
  ).eq("buyer_id", buyer.id).eq("id", id)
    .order("sku", { referencedTable: "order_items" }).maybeSingle();
  if (error) throw new Error("Order detail is unavailable.");
  return data;
});

export async function getBuyerNet30Order(id: string) {
  const buyer = await getVerifiedBuyer();
  if (!buyer || !orderId.test(id)) return null;
  const { data, error } = await (await sessionClient()).from("orders").select(
    `id,order_reference,fulfilment_status,authorised_at,po_number,gross_pence,goods_net_pence,delivery_net_pence,vat_pence,
    vat_rate_bps,delivery_service,promised_dispatch_date,estimated_delivery_date,dispatched_at,
    order_items(variant_id,sku,option_label,quantity,unit_price_pence,net_pence),invoices(status)`,
  ).eq("buyer_id", buyer.id).eq("payment_method", "net30").eq("id", id)
    .order("sku", { referencedTable: "order_items" }).maybeSingle();
  if (error) throw new Error("Net 30 confirmation is unavailable.");
  return data;
}

export async function getBuyerInvoiceUrl(orderId: string) {
  const { data, error } = await (await sessionClient()).rpc("get_own_buyer_invoice_url", { p_order_id: orderId });
  if (error) return null;
  return data;
}
