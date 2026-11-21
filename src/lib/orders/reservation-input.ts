import type { CreateOrderInput } from "./index";

export type ReservationRateKeys = { checkout_ip_key: string; checkout_email_key: string };

export function orderReservationArgs(input: CreateOrderInput, rateKeys?: ReservationRateKeys) {
  return {
    p_attempt_token: input.attemptToken,
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
      ...rateKeys,
    },
    p_hold_expires_at: input.holdExpiresAt,
    p_delivery_service: input.deliveryService,
    p_dispatch_date: input.promise.dispatchDate,
    p_delivery_date: input.promise.deliveryDate,
  };
}
