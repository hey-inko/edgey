import type { Database } from "@/lib/supabase/database.types";

type OrderPaymentStatus = Database["public"]["Enums"]["order_payment_status"];
type OrderFulfilmentStatus = Database["public"]["Enums"]["order_fulfilment_status"];

const paymentLabels = {
  pending: "Payment pending",
  invoiced: "Invoiced",
  partially_paid: "Partially paid",
  paid: "Paid",
  voided: "Payment voided",
  partially_refunded: "Partially refunded",
  refunded: "Refunded",
} satisfies Record<OrderPaymentStatus, string>;

export function orderPaymentLabel(payment: OrderPaymentStatus, fulfilment: OrderFulfilmentStatus) {
  return payment === "pending" && fulfilment === "cancelled" ? "Payment not completed" : paymentLabels[payment];
}

export const fulfilmentLabels = {
  awaiting_authorisation: "Awaiting confirmation",
  ready_to_pick: "Preparing for dispatch",
  picking: "Picking",
  dispatched: "Dispatched",
  cancelled: "Cancelled",
} satisfies Record<OrderFulfilmentStatus, string>;

const londonDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/London",
});

export function accountDate(value: string) {
  return londonDate.format(new Date(value));
}
