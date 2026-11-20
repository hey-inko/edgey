import { expect, test } from "vitest";
import { buildCatalogueView, readFilters, type Family, type Variant } from "@/lib/catalogue";
import { unitPricePence, withVatPence } from "@/lib/catalogue/display-prices";

const materials = ["vinyl", "textile"].map((slug, sortOrder) => ({ slug, name: slug, sortOrder, swatch: null }));
const variant = (sku: string, brand: string, material: (typeof materials)[number]): Variant => ({
  id: sku,
  sku,
  optionLabel: null,
  tool: null,
  angleDeg: null,
  shankMm: null,
  cuttingDepthMm: null,
  bladeThicknessMm: null,
  diameterMm: null,
  specs: {},
  prices: { oneToFour: 2250, fiveToNine: 1995, tenPlus: 1750 },
  availability: "in_stock",
  substrates: [material],
  compatibility: [{ code: "SHARED", kind: "item_number", brand: { slug: brand, name: brand }, machine: null, tool: null, adapter: null }],
});

const family: Family = {
  id: "family",
  familyCode: "EDG-DEMO",
  slug: "edg-demo",
  name: "Demo blade",
  description: "",
  toolType: { slug: "drag", name: "Drag", sortOrder: 0 },
  media: {},
  variants: [variant("EDG-A", "one", materials[0]!), variant("EDG-B", "two", materials[1]!)],
};

test("machine and material must match the same variant", () => {
  const mixed = buildCatalogueView([family], null, readFilters({ machine: "one", material: "textile" }));
  expect(mixed.cards).toEqual([]);
  const coherent = buildCatalogueView([family], null, readFilters({ machine: "one", material: "vinyl" }));
  expect(coherent.cards[0]?.variants.map(({ sku }) => sku)).toEqual(["EDG-A"]);
});

test("a filter does not silently preselect one configuration of a shared code", () => {
  const hits = family.variants.map(({ sku }) => ({
    matchType: "exact" as const,
    matchedCode: "SHARED",
    productSlug: family.slug,
    sku,
  }));
  const { cards } = buildCatalogueView([family], hits, readFilters({ q: "SHARED", machine: "one" }));
  expect(cards[0]?.href).toBe("/blades/edg-demo");
});

test("the displayed price applies each break to every blade and rounds VAT on the total", () => {
  const prices = { oneToFour: 2250, fiveToNine: 1995, tenPlus: 1750 };
  expect([1, 4, 5, 9, 10].map((quantity) => unitPricePence(prices, quantity))).toEqual([2250, 2250, 1995, 1995, 1750]);
  expect(withVatPence(unitPricePence(prices, 5) * 5)).toBe(11970);
  expect(withVatPence(1598)).toBe(1918);
});
