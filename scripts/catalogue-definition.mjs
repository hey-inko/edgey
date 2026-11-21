import { readFileSync } from "node:fs";

const blocks = {
  tool_categories: "slug, name, sort_order",
  substrates: "slug, name, swatch, sort_order",
  brands: "slug, name",
  products: "family_code, slug, name, tool_category, description, media, sort_order",
  variants: "sku, family_code, option_label, tool, angle_deg, shank_mm, cutting_depth_mm, blade_thickness_mm, diameter_mm, specs, evidence_note, price_1_4_pence, price_5_9_pence, price_10_plus_pence, sort_order",
  family_materials: "family_code, substrate",
  variant_materials: "sku, substrate",
  compatibility: "sku, code, code_kind, brand, machine, tool, adapter, legacy, evidence_note",
};

const ownerEvidence = "Owner-supplied specifications (2026-11-21; unverified)";
export const normaliseCode = (code) => code.replace(/[^a-z0-9]/gi, "").toUpperCase();

export async function catalogueDefinition(db, sql = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8")) {
  const definition = {};
  const sections = [...sql.matchAll(/^-- catalogue:(\w+)\r?\n([\s\S]*?)^-- catalogue:end\r?$/gm)];
  for (const [name, columns] of Object.entries(blocks)) {
    const matches = sections.filter(([, block]) => block === name);
    const values = matches[0]?.[2]?.trim();
    if (matches.length !== 1 || !/^values\s*\(/i.test(values ?? "")) {
      throw new Error("The catalogue definition is missing a unique VALUES block: " + name);
    }
    const { rows } = await db.query({
      text: `select * from (${values}) as source (${columns})`,
      queryMode: "extended",
    });
    if (rows.length === 0 || Object.keys(rows[0]).length !== columns.split(",").length) {
      throw new Error("Unexpected catalogue columns: " + name);
    }
    definition[name] = rows;
  }

  for (const product of definition.products) product.media = JSON.parse(product.media);
  for (const variant of definition.variants) {
    variant.specs = JSON.parse(variant.specs);
    variant.evidence_source = Object.keys(variant.specs).length ? ownerEvidence : null;
    for (const key of ["angle_deg", "shank_mm", "cutting_depth_mm", "blade_thickness_mm", "diameter_mm"]) {
      if (variant[key] !== null) variant[key] = Number(variant[key]);
    }
  }
  definition.compatibility = definition.compatibility.map(({ legacy, ...mapping }) => ({
    ...mapping,
    evidence_source: legacy ? "PRD Appendix A working list (unverified)" : ownerEvidence,
    is_private: mapping.code_kind === "alias",
  }));

  const unique = (rows, key) => new Set(rows.map(key)).size === rows.length;
  const products = new Set(definition.products.map(({ family_code }) => family_code));
  const familyCodes = new Map(definition.products.map(({ family_code }) => [normaliseCode(family_code), family_code]));
  const skus = new Map(definition.variants.map(({ sku, family_code }) => [sku, family_code]));
  const materials = new Set(definition.substrates.map(({ slug }) => slug));
  const categories = new Set(definition.tool_categories.map(({ slug }) => slug));
  const brands = new Set(definition.brands.map(({ slug }) => slug));
  const sharedCodes = Map.groupBy(definition.compatibility, ({ code }) => normaliseCode(code));
  const familyCollision = (code, family) => {
    const other = familyCodes.get(normaliseCode(code));
    return other !== undefined && other !== family;
  };
  if (["tool_categories", "substrates", "brands"].some((table) =>
        !unique(definition[table], ({ slug }) => slug) || !unique(definition[table], ({ name }) => name)) ||
      !unique(definition.products, ({ family_code }) => normaliseCode(family_code)) ||
      !unique(definition.products, ({ slug }) => slug) ||
      !unique(definition.variants, ({ sku }) => normaliseCode(sku)) ||
      !unique(definition.compatibility, ({ sku, code }) => sku + "/" + normaliseCode(code)) ||
      definition.variants.some(({ family_code }) => !products.has(family_code)) ||
      definition.products.some(({ family_code, tool_category }) =>
        !normaliseCode(family_code) || !categories.has(tool_category) || !definition.variants.some((v) => v.family_code === family_code)) ||
      definition.variants.some(({ sku, family_code }) => !normaliseCode(sku) || familyCollision(sku, family_code)) ||
      definition.compatibility.some(({ sku, code, code_kind, brand }) =>
        !skus.has(sku) || !normaliseCode(code) || !["alias", "item_number", "model"].includes(code_kind) ||
        (brand !== null && !brands.has(brand)) || familyCollision(code, skus.get(sku))) ||
      [...sharedCodes.values()].some(([first, ...peers]) => peers.some((peer) =>
        peer.code_kind === "alias" || peer.code_kind !== first.code_kind || peer.brand !== first.brand ||
        skus.get(peer.sku) !== skus.get(first.sku))) ||
      definition.family_materials.some(({ family_code, substrate }) => !products.has(family_code) || !materials.has(substrate)) ||
      definition.variant_materials.some(({ sku, substrate }) => !skus.has(sku) || !materials.has(substrate))) {
    throw new Error("The catalogue definition has conflicting or unknown keys.");
  }
  return definition;
}
