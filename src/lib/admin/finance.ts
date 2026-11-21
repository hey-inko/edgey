import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { adminRange } from "./pagination";
import { listFinanceRetryRequests } from "./replay";
import { serviceClient } from "@/lib/supabase/service";

export async function financeOverview(db: SupabaseClient<Database>, pages: {
  orders: number; captures: number; reviews: number; events: number; outbox: number;
  accounts: number; overdue: number; voids: number;
}) {
  const service = serviceClient();
  const financeColumns = "id,order_reference,business_name,payment_status,fulfilment_status,gross_pence,paid_pence,refunded_pence,created_at";
  const [orders, captures, reviews, events, outbox, accounts, overdue, voids] = await Promise.all([
    db.from("orders").select(`${financeColumns},payment_method`)
      .order("created_at", { ascending: false }).order("id").range(...adminRange(pages.orders)),
    db.from("orders").select(financeColumns)
      .eq("fulfilment_status", "cancelled")
      .in("payment_status", ["paid", "partially_paid", "partially_refunded"])
      .gt("paid_pence", 0)
      .order("created_at", { ascending: false }).order("id").range(...adminRange(pages.captures)),
    service.from("orders").select("id,order_reference,business_name,payment_method,payment_intent_id,payment_review_reason,payment_status,stripe_reconciliation_error")
      .or("stripe_reconciliation_error.not.is.null,and(payment_review_reason.not.is.null,or(payment_review_reason.neq.invoice_issued_after_hold_released,payment_status.neq.voided))")
      .is("payment_review_refund_id", null)
      .order("updated_at", { ascending: false }).order("id").range(...adminRange(pages.reviews)),
    db.from("provider_events").select("provider,event_id,event_type,state,last_error,updated_at")
      .eq("state", "failed").order("updated_at", { ascending: false }).order("provider").order("event_id")
      .range(...adminRange(pages.events)),
    db.from("order_outbox").select("order_id,orders(order_reference),message_key,state,last_error,updated_at")
      .eq("message_key", "order_confirmation").not("order_id", "is", null)
      .in("state", ["pending", "failed"])
      .order("state", { ascending: false }).order("updated_at", { ascending: false }).order("order_id")
      .range(...adminRange(pages.outbox)),
    db.from("trade_accounts").select("id,buyer_name,status,credit_limit_pence,trade_applications(company)")
      .order("created_at", { ascending: false }).order("id").range(...adminRange(pages.accounts)),
    service.from("overdue_invoices").select("order_id,trade_account_id,po_number,amount_remaining_pence,due_at")
      .order("due_at").order("order_id").range(...adminRange(pages.overdue)),
    service.from("orders").select("id,order_reference,trade_account_id,business_name,po_number,gross_pence")
      .eq("payment_method", "net30").eq("payment_status", "invoiced").eq("fulfilment_status", "cancelled")
      .is("dispatched_at", null).eq("paid_pence", 0).not("provider_invoice_id", "is", null)
      .order("updated_at", { ascending: false }).order("id").range(...adminRange(pages.voids)),
  ]);
  if (orders.error || captures.error || reviews.error || events.error || outbox.error || accounts.error ||
    overdue.error || voids.error) {
    throw new Error("Could not load the finance queues.");
  }
  const overdueIds = [...new Set(overdue.data.map((invoice) => invoice.trade_account_id))];
  const [queued, contacts] = await Promise.all([
    listFinanceRetryRequests(db, [
      ...events.data.filter((event) => event.provider === "stripe").map((event) => event.event_id),
      ...outbox.data.flatMap((message) => message.order_id && message.state === "failed" ? [message.order_id] : []),
    ]),
    overdueIds.length ? db.from("trade_accounts").select("id,trade_applications(company,email)").in("id", overdueIds) : null,
  ]);
  if (contacts?.error) throw new Error("Could not load overdue invoice contacts.");
  return {
    orders: orders.data, captures: captures.data, reviews: reviews.data, events: events.data, outbox: outbox.data, queued,
    accounts: accounts.data, overdue: overdue.data, voids: voids.data,
    overdueContacts: new Map(contacts?.data.map((account) => [account.id, account.trade_applications])),
  };
}
