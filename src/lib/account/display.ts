import type { Database } from "@/lib/supabase/database.types";

export const paymentLabels = {
  pending: "Payment pending",
  invoiced: "Invoiced",
  partially_paid: "Partially paid",
  paid: "Paid",
  voided: "Payment voided",
  partially_refunded: "Partially refunded",
  refunded: "Refunded",
} satisfies Record<Database["public"]["Enums"]["order_payment_status"], string>;

export const fulfilmentLabels = {
  awaiting_authorisation: "Awaiting authorisation",
  ready_to_pick: "Preparing for dispatch",
  picking: "Picking",
  dispatched: "Dispatched",
  cancelled: "Cancelled",
} satisfies Record<Database["public"]["Enums"]["order_fulfilment_status"], string>;

const londonDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/London",
});

export function accountDate(value: string) {
  return londonDate.format(new Date(value));
}
