import "server-only";

import { serviceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/database.types";
import { adminRange } from "./pagination";

type CatalogueFunctions = Pick<Database["public"]["Functions"],
  "admin_catalogue_update" | "admin_catalogue_review" | "admin_catalogue_set_publication">;

export const catalogueId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function variantReviewStatus(variant: { approved_at: string | null; rejected_at: string | null }) {
  return variant.approved_at ? "Approved" : variant.rejected_at ? "Rejected" : "Needs review";
}

export async function listAdminCatalogue(page: number) {
  const { data, error } = await serviceClient().from("variants")
    .select("id, sku, option_label, publication_status, approved_at, rejected_at, products(name, family_code)")
    .order("sku").range(...adminRange(page));
  if (error) throw new Error("Could not load the staff catalogue.");
  return data;
}

export async function getAdminCatalogueVariant(id: string) {
  const db = serviceClient();
  const { data: variant, error } = await db.from("variants").select(`
    id, sku, option_label, tool, angle_deg, shank_mm, cutting_depth_mm, blade_thickness_mm, diameter_mm, specs,
    supplier_name, supplier_part_number, price_1_4_pence, price_5_9_pence, price_10_plus_pence, availability,
    publication_status, approved_at, approved_by, rejected_at, rejected_by, evidence_source, evidence_note, catalogue_updated_at,
    products(name, family_code, description, tool_category, updated_at), variant_substrates(substrate),
    compatibility(id, code, code_kind, brand, machine, tool, adapter, evidence_source, evidence_note, evidence_url,
      verification_state, is_private, approved_at, approved_by, rejected_at, rejected_by, updated_at)
  `).eq("id", id).order("code", { referencedTable: "compatibility" }).maybeSingle();
  if (error) throw new Error("Could not load the catalogue variant.");
  if (!variant?.products) return null;

  const [categories, substrates, brands] = await Promise.all([
    db.from("tool_categories").select("slug, name").order("sort_order"),
    db.from("substrates").select("slug, name").order("name"),
    db.from("brands").select("slug, name").order("name"),
  ]);
  if (categories.error || substrates.error || brands.error) throw new Error("Could not load catalogue options.");
  return { variant, family: variant.products, categories: categories.data, substrates: substrates.data, brands: brands.data };
}

export async function getAdminCataloguePricing(id: string) {
  const { data, error } = await serviceClient().from("variants")
    .select("sku, option_label, price_1_4_pence, price_5_9_pence, price_10_plus_pence, products(name)")
    .eq("id", id).maybeSingle();
  if (error) throw new Error("Could not load the variant prices.");
  return data;
}

export async function mutateAdminCatalogue<K extends keyof CatalogueFunctions>(
  name: K, args: CatalogueFunctions[K]["Args"],
) {
  return serviceClient().rpc(name, args);
}
