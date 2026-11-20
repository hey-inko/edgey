import type Stripe from "stripe";
import type { Order } from "./store";

export const checkoutSessionId = /^cs_test_[A-Za-z0-9]{8,190}$/;
export const orderId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class PaymentReviewError extends Error {}

export function assertSessionMatches(order: Order, session: Stripe.Checkout.Session) {
  if (session.livemode !== false || session.mode !== "payment" || !checkoutSessionId.test(session.id) ||
    session.metadata?.edgey_order_id !== order.id || session.client_reference_id !== order.id ||
    order.payment_method !== "card" || (order.checkout_session_id && session.id !== order.checkout_session_id) ||
    session.expires_at * 1_000 !== Date.parse(order.hold_expires_at)) {
    throw new PaymentReviewError("Stripe Checkout identity or expiry does not match the order.");
  }
}

export function stripeId<T extends { id: string }>(value: string | T | null | undefined) {
  return typeof value === "string" ? value : value?.id;
}
