import "server-only";

import { getOrder, getOrderItems, paymentStore } from "@/lib/payments/store";
import { getStripe } from "@/lib/payments/stripe";
import type { Database } from "@/lib/supabase/database.types";
import { hostedStripeInvoice, renderConfirmation } from "./confirmation";
import { getEmailProvider, type SendResult } from "./provider";

type Claim = Database["public"]["Tables"]["order_outbox"]["Row"];
type Outcome = SendResult["status"] | "defer_invoice" | "preparation_failed" | "configuration_error";

type DeliveryStatus = "sent" | "failed" | "pending";
const invoiceGraceMs = 2 * 60_000;

async function invoiceLink(invoiceId: string | null) {
  if (!invoiceId) return null;
  try {
    const invoice = await getStripe().invoices.retrieve(invoiceId, {}, { maxNetworkRetries: 0, timeout: 3_000 });
    return hostedStripeInvoice(invoice.hosted_invoice_url);
  } catch {
    return null;
  }
}

async function deliver(claim: Claim): Promise<DeliveryStatus> {
  if (!claim.lease_token || !claim.order_id) return "failed";
  const db = paymentStore();
  const lease = { p_order_id: claim.order_id, p_lease_token: claim.lease_token };
  async function finish(outcome: Outcome, providerMessageId?: string) {
    const { data, error } = await db.rpc("finish_order_confirmation", {
      ...lease, p_outcome: outcome, p_provider_message_id: providerMessageId,
    });
    if (error) throw error;
    return data?.[0]?.state ?? "pending";
  }

  const provider = getEmailProvider();
  if (!provider || (claim.send_provider && claim.send_provider !== provider.name)) {
    return finish("configuration_error");
  }

  let payload: string | undefined;
  if (claim.send_payload === null) {
    const from = process.env.EMAIL_FROM?.trim();
    if (!from || /[\r\n]/.test(from)) return finish("configuration_error");

    const order = await getOrder(claim.order_id);
    if (!order) return finish("preparation_failed");
    const invoice = await invoiceLink(order.provider_invoice_id);
    if (!invoice && Date.now() - Date.parse(claim.created_at) < invoiceGraceMs) return finish("defer_invoice");
    const items = await getOrderItems(order.id);
    try {
      payload = JSON.stringify(renderConfirmation(order, items, from, invoice));
    } catch {
      return finish("preparation_failed");
    }
  }

  const beforeBegin = performance.now();
  const { data, error } = await db.rpc("begin_order_confirmation_send", {
    ...lease, ...(payload === undefined ? {} : { p_payload: payload, p_provider: provider.name }),
  });
  if (error) throw error;
  const body = data?.[0]?.send_payload;
  if (!body) return "pending";
  if (performance.now() - beforeBegin > 15_000) return finish("provider_uncertain");

  const result = await provider.send(`order-confirmation/${claim.order_id}`, body);
  return result.status === "sent" ? finish("sent", result.id) : finish(result.status);
}

async function claimOrderConfirmation(orderId?: string) {
  const { data, error } = await paymentStore().rpc("claim_order_confirmation", { p_replay_order_id: orderId });
  if (error) throw error;
  return data?.[0];
}

export async function processOrderConfirmations() {
  const started = performance.now();
  const result = { sent: 0, failed: 0, pending: 0 };
  for (let i = 0; i < 10 && performance.now() - started < 40_000; i++) {
    const claim = await claimOrderConfirmation();
    if (!claim) break;
    result[await deliver(claim)]++;
  }
  return result;
}

export async function replayOrderConfirmation(orderId: string): Promise<DeliveryStatus | "not_replayable"> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(orderId)) return "not_replayable";
  const claim = await claimOrderConfirmation(orderId);
  return claim?.lease_token ? deliver(claim) : "not_replayable";
}
