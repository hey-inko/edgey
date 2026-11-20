import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceDb } from "@/lib/admin/service";
import type { Database, Json } from "@/lib/supabase/database.types";

type Public = Database["public"];
type ReviewRejection = { rejected_at: string | null; rejected_by: string | null };
type WithRejection<K extends "variants" | "compatibility"> = Public["Tables"][K] & {
  Row: Public["Tables"][K]["Row"] & ReviewRejection;
};
type VariantArgs = { p_actor_id: string; p_variant_id: string; p_expected_updated_at: string };
type CatalogueFunctions = {
  admin_catalogue_update: {
    Args: VariantArgs & { p_expected_product_updated_at: string; p_selling: Json };
    Returns: string;
  };
  admin_catalogue_review: {
    Args: VariantArgs & {
      p_approve: boolean;
      p_evidence_source: string;
      p_evidence_note: string;
      p_compatibility_id?: string;
      p_expected_mapping_updated_at?: string;
      p_evidence_url?: string;
      p_brand?: string;
      p_machine?: string;
      p_tool?: string;
      p_adapter?: string;
    };
    Returns: string;
  };
  admin_catalogue_set_publication: { Args: VariantArgs & { p_publish: boolean }; Returns: string };
};
type CatalogueDatabase = {
  public: Omit<Public, "Functions" | "Tables"> & {
    Functions: Public["Functions"] & CatalogueFunctions;
    Tables: Omit<Public["Tables"], "variants" | "compatibility"> & {
      variants: WithRejection<"variants">;
      compatibility: WithRejection<"compatibility">;
    };
  };
};

function catalogueDb() {
  return serviceDb() as unknown as SupabaseClient<CatalogueDatabase>;
}

export const catalogueId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function variantReviewStatus(variant: { approved_at: string | null; rejected_at: string | null }) {
  return variant.approved_at ? "Approved" : variant.rejected_at ? "Rejected" : "Needs review";
}

export async function listAdminCatalogue() {
  const { data, error } = await catalogueDb().from("variants")
    .select("id, sku, option_label, publication_status, approved_at, rejected_at, products(name, family_code)")
    .order("sku");
  if (error) throw new Error("Could not load the staff catalogue.");
  return data;
}

export async function getAdminCatalogueVariant(id: string) {
  const db = catalogueDb();
  const { data: variant, error } = await db.from("variants").select(`
    id, sku, option_label, tool, angle_deg, shank_mm, cutting_depth_mm, blade_thickness_mm, diameter_mm, specs,
    supplier_name, supplier_part_number, price_1_4_pence, price_5_9_pence, price_10_plus_pence, availability,
    publication_status, approved_at, approved_by, rejected_at, rejected_by, evidence_source, evidence_note, updated_at,
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

export async function mutateAdminCatalogue<K extends keyof CatalogueFunctions>(
  name: K, args: CatalogueFunctions[K]["Args"],
) {
  return catalogueDb().rpc(name, args);
}
