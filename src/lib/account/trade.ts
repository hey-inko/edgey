import "server-only";

import { cache } from "react";
import { getVerifiedBuyer, sessionClient } from "@/lib/auth/server";
import { getBuyerInvoiceUrl } from "./server";

export const getBuyerTradePosition = cache(async () => {
  const buyer = await getVerifiedBuyer();
  if (!buyer) return null;
  const { data, error } = await (await sessionClient()).from("trade_credit_position")
    .select("trade_account_id,status,available_credit_pence,outstanding_pence")
    .eq("buyer_id", buyer.id).maybeSingle();
  if (error) throw new Error("Trade account is unavailable.");
  if (!data) return null;
  if (data.available_credit_pence === null || data.outstanding_pence === null) {
    throw new Error("Trade account is unavailable.");
  }
  return {
    accountId: data.trade_account_id,
    status: data.status,
    availableCreditPence: data.available_credit_pence,
    outstandingBalancePence: data.outstanding_pence,
  };
});

const invoicesPerPage = 10;

export async function listBuyerTradeInvoices(page: number) {
  const trade = await getBuyerTradePosition();
  if (!trade) return null;
  const from = (page - 1) * invoicesPerPage;
  const { data, error } = await (await sessionClient()).from("invoices")
    .select("order_id,po_number,amount_remaining_pence,due_at,status,orders(fulfilment_status)")
    .eq("trade_account_id", trade.accountId)
    .order("issued_at", { ascending: false }).order("order_id", { ascending: false })
    .range(from, from + invoicesPerPage);
  if (error) throw new Error("Trade invoices are unavailable.");
  return {
    invoices: await Promise.all(data.slice(0, invoicesPerPage).map(async ({ orders, ...invoice }) => {
      const cancelled = orders?.fulfilment_status === "cancelled";
      return { ...invoice, cancelled, url: orders && !cancelled ? await getBuyerInvoiceUrl(invoice.order_id) : null };
    })),
    hasOlder: data.length > invoicesPerPage,
  };
}
