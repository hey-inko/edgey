import "server-only";
import { isIP } from "node:net";
import { requestFingerprint } from "@/lib/requests/rate-limit";
import { PaymentConfigurationError } from "./config";
import { paymentStore } from "./store";

export class CheckoutRateLimitError extends Error {}

export async function limitCheckout(request: Request, origin: string, scope: "checkout" | "checkout_close", recipient: string) {
  const ip = process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for")?.trim() : null;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
  const address = ip && isIP(ip) ? ip.toLowerCase() : local ? "local" : null;
  if (!address || Buffer.byteLength(process.env.EDGEY_REQUEST_HASH_KEY ?? "") < 32) {
    throw new PaymentConfigurationError("Checkout rate limiting needs EDGEY_REQUEST_HASH_KEY and a trusted client address.");
  }
  const { data, error } = await paymentStore().rpc("consume_request_rate_limit", {
    p_scope: scope,
    p_ip_key: requestFingerprint("ip", address),
    p_email_key: requestFingerprint("email", recipient.toLowerCase()),
  });
  if (error) throw error;
  if (!data) throw new CheckoutRateLimitError("Too many checkout attempts. Please try again later.");
}
