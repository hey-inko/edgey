import "server-only";
import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import { serviceClient } from "@/lib/supabase/service";
import { localRequestMode } from "./availability";
import { clientNetwork } from "./client-network";

type FormScope = "enquiry" | "trial" | "trade" | "trade_sign_in" | "staff_sign_in" | "staff_mfa";

export function requestFingerprint(purpose: "ip" | "email" | "search" | "finder" | "staff_ip_email" | "selection_quote", value: string): string {
  const key = process.env.EDGEY_REQUEST_HASH_KEY;
  if (!key || Buffer.byteLength(key) < 32) throw new Error("Request hashing configuration is missing.");
  return createHmac("sha256", key).update(purpose + "\0" + value).digest("hex");
}

async function requestIpKey() {
  const forwarded = process.env.VERCEL === "1"
    ? (await headers()).get("x-vercel-forwarded-for")?.trim()
    : undefined;
  const network = forwarded && clientNetwork(forwarded);
  if (network) return requestFingerprint("ip", network);
  return localRequestMode() ? requestFingerprint("ip", "local") : null;
}

async function consume(scope: FormScope | "finder" | "selection_quote", ip: string, secondaryKey: string) {
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
  const normalised = email.toLowerCase();
  const secondaryKey = scope === "staff_sign_in" || scope === "staff_mfa"
    ? requestFingerprint("staff_ip_email", ip + "\0" + normalised)
    : requestFingerprint("email", normalised);
  return consume(scope, ip, secondaryKey);
}

export async function allowFinderEvent(): Promise<boolean> {
  const ip = await requestIpKey();
  return ip !== null && consume("finder", ip, requestFingerprint("finder", "global"));
}

export async function allowSelectionQuote(): Promise<boolean> {
  const ip = await requestIpKey();
  return ip !== null && consume("selection_quote", ip, requestFingerprint("selection_quote", "global"));
}
