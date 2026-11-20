import "server-only";
import { assertSessionMatches, checkoutSessionId, PaymentReviewError } from "./session-identity";
import { getOrderItems, paymentStore } from "./store";
import { getStripe } from "./stripe";

export type CheckoutSuccess = { kind: "pending" | "expired" | "review" } | {
  kind: "confirmed";
  reference: string;
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
  const stripe = getStripe();
  const { data: order, error } = await paymentStore().from("orders").select("*")
    .eq("checkout_session_id", sessionId).maybeSingle();
  if (error) throw error;
  if (!order) return null;
  try {
    assertSessionMatches(order, await stripe.checkout.sessions.retrieve(sessionId));
  } catch (error) {
    if (error instanceof PaymentReviewError || (error as { statusCode?: number })?.statusCode === 404) return null;
    throw error;
  }
  if (order.payment_review_reason || order.stripe_reconciliation_error) return { kind: "review" };
  if (!order.authorised_at) return { kind: order.fulfilment_status === "cancelled" ? "expired" : "pending" };
  const items = await getOrderItems(order.id);
  return {
    kind: "confirmed",
    reference: order.id,
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
