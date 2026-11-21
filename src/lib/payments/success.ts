import "server-only";
import { assertSessionMatches, checkoutSessionId, PaymentReviewError } from "./session-identity";
import { paymentStore } from "./store";
import { getStripe } from "./stripe";

export type CheckoutSuccess = { kind: "pending" | "expired" | "review" | "cancelled" | "cancelled-refunded" } | {
  kind: "confirmed";
  reference: string;
  deliveryService: string;
  dispatchDate: string;
  deliveryDate: string;
  vatRateBps: number;
  goodsNetPence: number;
  deliveryNetPence: number;
  vatPence: number;
  grossPence: number;
  lines: {
    variantId: string;
    sku: string;
    optionLabel: string;
    quantity: number;
    unitPricePence: number;
    netPence: number;
  }[];
};

export async function readCheckoutSuccess(sessionId: string): Promise<CheckoutSuccess | null> {
  if (!checkoutSessionId.test(sessionId)) return null;
  const db = paymentStore();
  const { data: order, error } = await db.from("orders").select(
    "id,payment_method,checkout_session_id,hold_expires_at,payment_review_reason,authorised_at,stripe_reconciliation_error,fulfilment_status,order_reference,delivery_service,promised_dispatch_date,estimated_delivery_date,vat_rate_bps,goods_net_pence,delivery_net_pence,vat_pence,gross_pence",
  )
    .eq("checkout_session_id", sessionId).maybeSingle();
  if (error) throw error;
  if (!order) return null;
  try {
    assertSessionMatches(order, await getStripe().checkout.sessions.retrieve(sessionId));
  } catch (error) {
    if (error instanceof PaymentReviewError || (error as { statusCode?: number })?.statusCode === 404) return null;
    throw error;
  }
  if (order.fulfilment_status === "cancelled" && order.paid_pence > 0 && order.payment_status === "refunded") {
    return { kind: "cancelled-refunded" };
  }
  if (order.payment_review_reason || (!order.authorised_at && order.stripe_reconciliation_error)) return { kind: "review" };
  if (order.fulfilment_status === "cancelled" && order.paid_pence > 0) return { kind: "cancelled" };
  if (!order.authorised_at) return { kind: order.fulfilment_status === "cancelled" ? "expired" : "pending" };
  const { data: items, error: itemsError } = await db.from("order_items")
    .select("variant_id,sku,option_label,quantity,unit_price_pence,net_pence").eq("order_id", order.id).order("variant_id");
  if (itemsError) throw itemsError;
  return {
    kind: "confirmed",
    reference: order.order_reference,
    deliveryService: order.delivery_service,
    dispatchDate: order.promised_dispatch_date,
    deliveryDate: order.estimated_delivery_date,
    vatRateBps: order.vat_rate_bps,
    goodsNetPence: order.goods_net_pence,
    deliveryNetPence: order.delivery_net_pence,
    vatPence: order.vat_pence,
    grossPence: order.gross_pence,
    lines: items.map((item) => ({
      variantId: item.variant_id,
      sku: item.sku,
      optionLabel: item.option_label,
      quantity: item.quantity,
      unitPricePence: item.unit_price_pence,
      netPence: item.net_pence,
    })),
  };
}
