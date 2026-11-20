import type Stripe from "stripe";
import { calculateVat, formatGbp } from "@/lib/commerce";
import type { Order, OrderItem } from "./store";

type SessionOrder = Pick<Order, "id" | "email" | "recipient_name" | "phone" | "address_line1" |
  "address_line2" | "address_town" | "address_region" | "address_postcode" | "address_country" |
  "hold_expires_at" | "delivery_service" | "goods_net_pence" | "delivery_net_pence" |
  "gross_pence" | "vat_pence" | "vat_rate_bps">;
type SessionItem = Pick<OrderItem, "sku" | "option_label" | "quantity" | "gross_pence" | "net_pence" | "tax_pence">;

export function stripeSessionParams(
  order: SessionOrder,
  items: readonly SessionItem[],
  origin: string,
): Stripe.Checkout.SessionCreateParams {
  const deliveryTax = calculateVat(order.delivery_net_pence, order.vat_rate_bps);
  if (!deliveryTax.ok) throw new Error("Invalid saved delivery tax.");
  const settledLine = (name: string, net: number, tax: number, gross: number) => ({
    quantity: 1,
    price_data: {
      currency: "gbp",
      unit_amount: gross,
      product_data: {
        name,
        description: `${formatGbp(net)} ex VAT · ${formatGbp(tax)} VAT`,
      },
    },
  });
  const line_items = items.map((item) => settledLine(
    `${item.quantity} × ${item.sku} · ${item.option_label}`.slice(0, 120),
    item.net_pence,
    item.tax_pence,
    item.gross_pence,
  ));
  if (order.delivery_net_pence) {
    line_items.push(settledLine(
      `Delivery · ${order.delivery_service}`,
      order.delivery_net_pence,
      deliveryTax.value,
      order.delivery_net_pence + deliveryTax.value,
    ));
  }
  if (!items.length || line_items.length > 100 ||
    items.reduce((sum, item) => sum + item.net_pence, 0) !== order.goods_net_pence ||
    items.reduce((sum, item) => sum + item.tax_pence, deliveryTax.value) !== order.vat_pence ||
    line_items.reduce((sum, line) => sum + line.price_data.unit_amount, 0) !== order.gross_pence) {
    throw new Error("Stripe line totals do not match the saved order.");
  }
  const metadata = { edgey_order_id: order.id };
  return {
    mode: "payment",
    allowed_payment_method_types: ["card"],
    adaptive_pricing: { enabled: false },
    automatic_tax: { enabled: false },
    client_reference_id: order.id,
    customer_email: order.email,
    metadata,
    payment_intent_data: {
      capture_method: "automatic",
      metadata,
      shipping: {
        name: order.recipient_name,
        ...(order.phone ? { phone: order.phone } : {}),
        address: {
          line1: order.address_line1,
          ...(order.address_line2 ? { line2: order.address_line2 } : {}),
          city: order.address_town,
          ...(order.address_region ? { state: order.address_region } : {}),
          postal_code: order.address_postcode,
          country: order.address_country,
        },
      },
    },
    invoice_creation: {
      enabled: true,
      invoice_data: {
        metadata,
        footer: `Edgey order ${order.id}\nSubtotal ex VAT: ${formatGbp(order.goods_net_pence + order.delivery_net_pence)}\nVAT (${order.vat_rate_bps / 100}%): ${formatGbp(order.vat_pence)}\nTotal including VAT: ${formatGbp(order.gross_pence)}`,
      },
    },
    line_items,
    expires_at: Date.parse(order.hold_expires_at) / 1_000,
    success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/checkout`,
  };
}
