import "server-only";
import { clientNetwork } from "@/lib/requests/client-network";
import { requestFingerprint } from "@/lib/requests/rate-limit";
import { PaymentConfigurationError } from "./config";
import { paymentStore } from "./store";

const checkoutRateLimitError = class extends Error {};
export const checkoutRateLimitMessage = "Too many checkout attempts. Please try again later.";

export function checkoutRateKeys(request: Request, origin: string, recipient: string) {
  const ip = process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for")?.trim() : null;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
  const address = (ip && clientNetwork(ip)) || (local ? "local" : null);
  if (!address || Buffer.byteLength(process.env.EDGEY_REQUEST_HASH_KEY ?? "") < 32) {
    throw new PaymentConfigurationError("Checkout rate limiting needs EDGEY_REQUEST_HASH_KEY and a trusted client address.");
  }
  return { checkout_ip_key: requestFingerprint("ip", address), checkout_email_key: requestFingerprint("email", recipient.toLowerCase()) };
}

export async function limitCheckout(request: Request, origin: string, scope: "checkout_review" | "checkout_close", recipient: string) {
  const { checkout_ip_key, checkout_email_key } = checkoutRateKeys(request, origin, recipient);
  const { data, error } = await paymentStore().rpc("consume_checkout_rate_limit", {
    p_scope: scope, p_ip_key: checkout_ip_key, p_email_key: checkout_email_key,
  });
  if (error) throw error;
  if (!data) throw new checkoutRateLimitError(checkoutRateLimitMessage);
}

export function isCheckoutRateLimit(error: unknown) {
  return error instanceof checkoutRateLimitError || (error as { code?: string } | null)?.code === "P0901";
}
