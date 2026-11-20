import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

export type CreateOrderInput = {
  attemptToken: string;
  buyerId?: string;
  lines: readonly {
    variantId: string;
    quantity: number;
    unitPricePence: number;
  }[];
  contact: {
    email: string;
    businessName: string;
    recipientName: string;
    buyingForWork: true;
    phone?: string;
  };
  address: {
    line1: string;
    line2?: string;
    town: string;
    region?: string;
    postcode: string;
    country: "GB";
  };
  totals: {
    goodsNetPence: number;
    deliveryNetPence: number;
    vatRateBps: number;
    vatPence: number;
    grossPence: number;
  };
  holdExpiresAt: string;
  deliveryService: string;
  promise: { dispatchDate: string; deliveryDate: string };
};

export type ConfirmPaymentInput = {
  orderId: string;
  sessionId: string;
  paymentIntentId: string;
  amountPence: number;
  currency: "GBP" | "gbp";
  invoiceId?: string;
  promise?: CreateOrderInput["promise"];
};

type WarehouseOrderOperation = {
  orderId: string;
  operationKey: string;
  actorId: string;
};
type Functions = Database["public"]["Functions"];

let client: SupabaseClient<Database> | undefined;

async function call<Name extends keyof Functions>(
  name: Name,
  args: Functions[Name]["Args"],
) {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key)
      throw new Error("Supabase service-role configuration is missing.");
    client = createClient<Database>(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  if (data === null)
    throw new Error(`Supabase did not return a result for ${name}.`);
  return data;
}

export function createOrderWithReservations(input: CreateOrderInput) {
  return call("create_order_with_reservations", {
    p_attempt_token: input.attemptToken,
    p_buyer_id: input.buyerId,
    p_lines: input.lines.map(({ variantId, quantity, unitPricePence }) => ({
      variant_id: variantId,
      quantity,
      unit_price_pence: unitPricePence,
    })),
    p_contact: {
      email: input.contact.email,
      business_name: input.contact.businessName,
      recipient_name: input.contact.recipientName,
      buying_for_work: input.contact.buyingForWork,
      phone: input.contact.phone,
    },
    p_address: input.address,
    p_totals: {
      goods_net_pence: input.totals.goodsNetPence,
      delivery_net_pence: input.totals.deliveryNetPence,
      vat_rate_bps: input.totals.vatRateBps,
      vat_pence: input.totals.vatPence,
      gross_pence: input.totals.grossPence,
    },
    p_hold_expires_at: input.holdExpiresAt,
    p_delivery_service: input.deliveryService,
    p_dispatch_date: input.promise.dispatchDate,
    p_delivery_date: input.promise.deliveryDate,
  });
}

export function bindCheckoutSession(input: {
  orderId: string;
  sessionId: string;
  expiresAt: string;
}) {
  return call("bind_checkout_session", {
    p_order_id: input.orderId,
    p_session_id: input.sessionId,
    p_expires_at: input.expiresAt,
  });
}

export function releaseReservation(
  input: { orderId: string; operationKey: string } & (
    | { reason: "expired"; sessionId: string }
    | { reason: "closed"; sessionId?: string }
  ),
) {
  return call("release_reservation", {
    p_order_id: input.orderId,
    p_operation_key: input.operationKey,
    p_reason: input.reason,
    p_session_id: input.sessionId,
  });
}

export function confirmPayment(input: ConfirmPaymentInput) {
  return call("confirm_payment", {
    p_order_id: input.orderId,
    p_session_id: input.sessionId,
    p_payment_intent_id: input.paymentIntentId,
    p_amount_pence: input.amountPence,
    p_currency: input.currency,
    p_invoice_id: input.invoiceId,
    p_dispatch_date: input.promise?.dispatchDate,
    p_delivery_date: input.promise?.deliveryDate,
  });
}

export function recordRefund(input: {
  orderId: string;
  refundId: string;
  paymentIntentId: string;
  amountPence: number;
  currency: ConfirmPaymentInput["currency"];
}) {
  return call("record_refund", {
    p_order_id: input.orderId,
    p_refund_id: input.refundId,
    p_payment_intent_id: input.paymentIntentId,
    p_amount_pence: input.amountPence,
    p_currency: input.currency,
  });
}

export function cancelOrder(input: WarehouseOrderOperation) {
  return call("cancel_order", {
    p_order_id: input.orderId,
    p_operation_key: input.operationKey,
    p_actor_id: input.actorId,
  });
}

export function startPicking(input: WarehouseOrderOperation) {
  return call("start_picking", {
    p_order_id: input.orderId,
    p_operation_key: input.operationKey,
    p_actor_id: input.actorId,
  });
}

export function dispatchOrder(
  input: WarehouseOrderOperation & { carrier: string; trackingNumber: string },
) {
  return call("dispatch_order", {
    p_order_id: input.orderId,
    p_operation_key: input.operationKey,
    p_actor_id: input.actorId,
    p_carrier: input.carrier,
    p_tracking_number: input.trackingNumber,
  });
}

export function recordReturn(input: {
  orderId: string;
  returnId: string;
  actorId: string;
  variantId: string;
  quantity: number;
  reason: string;
  lookupCode?: string;
}) {
  return call("record_return", {
    p_order_id: input.orderId,
    p_return_id: input.returnId,
    p_actor_id: input.actorId,
    p_variant_id: input.variantId,
    p_quantity: input.quantity,
    p_reason: input.reason,
    p_lookup_code: input.lookupCode,
  });
}

export function restoreStock(input: {
  returnId: string;
  operationKey: string;
  actorId: string;
  quantity: number;
}) {
  return call("restore_stock", {
    p_return_id: input.returnId,
    p_operation_key: input.operationKey,
    p_actor_id: input.actorId,
    p_quantity: input.quantity,
  });
}

export function receiveStock(input: {
  variantId: string;
  operationKey: string;
  quantity: number;
  actorId: string;
}) {
  return call("receive_stock", {
    p_variant_id: input.variantId,
    p_operation_key: input.operationKey,
    p_quantity: input.quantity,
    p_actor_id: input.actorId,
  });
}

export function recordProviderEvent(input: {
  provider: string;
  eventId: string;
  eventType: string;
  payload: Record<string, Json>;
}) {
  return call("record_provider_event", {
    p_provider: input.provider,
    p_event_id: input.eventId,
    p_event_type: input.eventType,
    p_payload: input.payload,
  });
}

export function markProviderEvent(
  input: { provider: string; eventId: string } & (
    | { state: "processed" }
    | { state: "failed"; error: string }
  ),
) {
  return call("mark_provider_event", {
    p_provider: input.provider,
    p_event_id: input.eventId,
    p_state: input.state,
    p_error: input.state === "failed" ? input.error : undefined,
  });
}

export function enqueueOrderConfirmation(orderId: string) {
  return call("enqueue_order_confirmation", { p_order_id: orderId });
}
