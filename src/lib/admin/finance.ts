import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { adminRange } from "./pagination";
import { listFinanceRetryRequests } from "./replay";
import { serviceClient } from "@/lib/supabase/service";

export async function financeOverview(db: SupabaseClient<Database>, pages: {
  orders: number; captures: number; reviews: number; events: number; outbox: number;
}) {
  const financeColumns = "id,business_name,payment_status,fulfilment_status,gross_pence,paid_pence,refunded_pence,created_at";
  const [orders, captures, reviews, events, outbox] = await Promise.all([
    db.from("orders").select(financeColumns)
      .order("created_at", { ascending: false }).order("id").range(...adminRange(pages.orders)),
    db.from("orders").select(financeColumns)
      .eq("fulfilment_status", "cancelled")
      .in("payment_status", ["paid", "partially_paid", "partially_refunded"])
      .gt("paid_pence", 0)
      .order("created_at", { ascending: false }).order("id").range(...adminRange(pages.captures)),
    serviceClient().from("orders").select("id,business_name,payment_review_reason,payment_status,payment_review_refund_id")
      .not("payment_review_reason", "is", null).is("payment_review_refund_id", null)
      .order("updated_at", { ascending: false }).order("id").range(...adminRange(pages.reviews)),
    db.from("provider_events").select("provider,event_id,event_type,state,last_error,updated_at")
      .eq("state", "failed").order("updated_at", { ascending: false }).order("provider").order("event_id")
      .range(...adminRange(pages.events)),
    db.from("order_outbox").select("order_id,message_key,state,updated_at")
      .eq("message_key", "order_confirmation").not("order_id", "is", null)
      .in("state", ["pending", "failed"])
      .order("state", { ascending: false }).order("updated_at", { ascending: false }).order("order_id")
      .range(...adminRange(pages.outbox)),
  ]);
  if (orders.error || captures.error || reviews.error || events.error || outbox.error) {
    throw new Error("Could not load the finance queues.");
  }
  const queued = await listFinanceRetryRequests(db, [
    ...events.data.filter((event) => event.provider === "stripe").map((event) => event.event_id),
    ...outbox.data.flatMap((message) => message.order_id && message.state === "failed" ? [message.order_id] : []),
  ]);
  return { orders: orders.data, captures: captures.data, reviews: reviews.data, events: events.data, outbox: outbox.data, queued };
}
