import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { headers } from "next/headers";
import { serviceClient } from "@/lib/supabase/service";
import { localRequestMode } from "./availability";

type FormScope = "enquiry" | "trial" | "trade" | "trade_sign_in";

export function requestFingerprint(purpose: "ip" | "email" | "search" | "finder", value: string): string {
  const key = process.env.EDGEY_REQUEST_HASH_KEY;
  if (!key || Buffer.byteLength(key) < 32) throw new Error("Request hashing configuration is missing.");
  return createHmac("sha256", key).update(purpose + "\0" + value).digest("hex");
}

async function requestIpKey() {
  const forwarded = process.env.VERCEL === "1"
    ? (await headers()).get("x-vercel-forwarded-for")?.trim()
    : undefined;
  if (forwarded && isIP(forwarded)) return requestFingerprint("ip", forwarded.toLowerCase());
  return localRequestMode() ? requestFingerprint("ip", "local") : null;
}

async function consume(scope: FormScope | "finder", ip: string, secondaryKey: string) {
  const { data, error } = await serviceClient().rpc("consume_request_rate_limit", {
    p_scope: scope,
    p_ip_key: ip,
    p_email_key: secondaryKey,
  });
  if (error) throw new Error("Request rate limiter is unavailable.");
  return data === true;
}

export async function allowRequest(scope: FormScope, email: string): Promise<boolean> {
  const ip = await requestIpKey();
  if (!ip) throw new Error("Trusted client address is unavailable.");
  return consume(scope, ip, requestFingerprint("email", email.toLowerCase()));
}

export async function allowFinderEvent(): Promise<boolean> {
  const ip = await requestIpKey();
  return ip !== null && consume("finder", ip, requestFingerprint("finder", "global"));
}
