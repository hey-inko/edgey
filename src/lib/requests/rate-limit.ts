import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { headers } from "next/headers";
import { serviceClient } from "@/lib/supabase/service";

type Scope = "enquiry" | "trial" | "trade" | "trade_sign_in";

export function requestFingerprint(purpose: "ip" | "email" | "search", value: string): string {
  const key = process.env.EDGEY_REQUEST_HASH_KEY;
  if (!key) throw new Error("Request hashing configuration is missing.");
  return createHmac("sha256", key).update(purpose + "\0" + value).digest("hex");
}

export async function allowRequest(scope: Scope, email: string): Promise<boolean> {
  const forwarded = process.env.VERCEL === "1"
    ? (await headers()).get("x-vercel-forwarded-for")?.trim()
    : undefined;
  const ip = forwarded && isIP(forwarded) ? forwarded.toLowerCase() : "unavailable";
  const { data, error } = await serviceClient().rpc("consume_request_rate_limit", {
    p_scope: scope,
    p_ip_key: requestFingerprint("ip", ip),
    p_email_key: requestFingerprint("email", email.toLowerCase()),
  });
  if (error) throw new Error("Request rate limiter is unavailable.");
  return data === true;
}
