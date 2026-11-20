import "server-only";

import { redirect } from "next/navigation";
import { MACHINE_BRANDS } from "@/lib/requests/forms";
import { requireStaff } from "./auth";
import { requestsDb } from "./request-schema";

export async function requireRequestsStaff() {
  const staff = await requireStaff();
  if (!staff.roles.includes("catalogue") && !staff.roles.includes("warehouse")) redirect("/admin");
  return staff;
}

export async function publishedRequestVariants() {
  const { data, error } = await requestsDb().from("variants")
    .select("id,sku,option_label,tool,availability")
    .eq("publication_status", "published").order("sku");
  if (error) throw new Error("Could not load published variants.");
  return data;
}

export async function requestVariantLabels(ids: string[]) {
  const variants = new Map<string, { sku: string; option_label: string | null; tool: string | null }>();
  if (!ids.length) return variants;
  const { data, error } = await requestsDb().from("variants")
    .select("id,sku,option_label,tool").in("id", ids);
  if (error) throw new Error("Could not load the selected variants.");
  for (const variant of data) variants.set(variant.id, variant);
  return variants;
}

export function enquiryStatus(status: string) {
  if (status === "converted") return "Matched";
  if (status === "replied") return "Replied";
  if (status === "resolved") return "Closed";
  return "Open";
}

export function requestBrand(brand: string) {
  return MACHINE_BRANDS.find(([key]) => key === brand)?.[1] ?? brand;
}

export function trialStatus(status: string, state?: string | null) {
  if (state === "allocated") return "Approved · two units reserved";
  if (state === "dispatched") return "Dispatched";
  if (state === "cancelled") return "Cancelled · allocation released";
  if (status === "approved") return "Approved";
  if (status === "declined") return "Declined";
  if (status === "in_review") return "In review";
  return "Pending";
}

export type RequestVariantLabel = { sku: string; option_label: string | null; tool: string | null };

export function variantLabel(variant: RequestVariantLabel | undefined) {
  return variant ? [variant.sku, variant.option_label || variant.tool].filter(Boolean).join(" · ") : "Variant unavailable";
}
