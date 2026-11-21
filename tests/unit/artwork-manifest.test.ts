import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import manifest from "../../docs/artwork-sources.json";

type Artwork = {
  sku: string;
  drawing: string;
  photo: string | null;
  publisher: string | null;
  page: string | null;
  image: string | null;
  rights: "rights not cleared" | "missing" | "cleared";
  notes: string;
};

const artwork = manifest as Artwork[];
const seed = readFileSync("supabase/seed.sql", "utf8");
const products = seed.split("insert into public.products")[1]?.split("on conflict")[0] ?? "";
const variants = seed.split("with data (sku, family_code,")[1]?.split("insert into public.variants")[0] ?? "";
const familyMedia = new Map([...products.matchAll(/^\s+\('([^']+)',.*'(\{[^']*\})', \d+\),?$/gm)]
  .map(([, family, value]) => [family, JSON.parse(value!) as Record<string, unknown>]));
const skusByFamily = Map.groupBy([...variants.matchAll(/^\s+\('([^']+)', '([^']+)'/gm)], ([, , family]) => family);
const packMedia = new Map([
  ["EDG-Z10", { drawing: "drag-line.svg", photo: "drag.webp", proof: "coral" }],
  ["EDG-Z16", { drawing: "oscillating-line.svg", photo: "oscillating.webp", proof: "cyan" }],
  ["EDG-Z50", { drawing: "rotary-line.svg", photo: "rotary.webp", proof: "violet" }],
  ["EDG-SR6223", { drawing: "cylinder-line.svg", photo: "cylinder.webp", proof: "lime" }],
]);

it("covers every non-design-pack variant and keeps public seed metadata free of sibling SKUs", () => {
  expect(skusByFamily.size).toBeGreaterThan(packMedia.size);
  expect(artwork.map(({ sku }) => sku).sort()).toEqual(
    [...skusByFamily.values()].flatMap((rows) => rows.map((row) => row[1]))
      .filter((sku) => !packMedia.has(sku!)).sort(),
  );
  for (const [sku, media] of packMedia) expect(familyMedia.get(sku)).toEqual(media);

  const bySku = new Map(artwork.map((entry) => [entry.sku, entry]));
  for (const [family, skus] of skusByFamily) {
    if (!family || packMedia.has(family)) continue;
    const media = familyMedia.get(family);
    expect(media?.proof).toMatch(/^(prism|coral|cyan|lime|violet)$/);
    if (skus.length > 1) {
      expect(media).toEqual({ artwork: "by-sku", proof: media?.proof });
      continue;
    }
    const sku = skus[0]?.[1];
    expect(sku).toBe(family);
    const entry = bySku.get(family);
    expect(media).toEqual({ drawing: entry?.drawing, ...(entry?.photo && { photo: entry.photo }), proof: media?.proof });
  }
});

it("keeps manifest artwork on disk at the right basename and out of public for uncleared photos", () => {
  const publicNames = new Set(readdirSync("public", { recursive: true, encoding: "utf8" }).map((path) => basename(path)));
  for (const entry of artwork) {
    expect(entry.sku).toMatch(/^EDG-[A-Z0-9-]+$/);
    expect(entry.drawing).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.svg$/);
    expect(lstatSync(join("public/line-art", entry.drawing)).isFile()).toBe(true);
    expect(["rights not cleared", "cleared", "missing"]).toContain(entry.rights);
    expect(typeof entry.notes).toBe("string");
    for (const value of [entry.publisher, entry.page, entry.image]) {
      expect(value === null || typeof value === "string").toBe(true);
    }

    if (entry.rights === "missing") {
      expect(entry.photo).toBeNull();
      continue;
    }
    expect(entry.photo).toBe(entry.sku.toLowerCase() + ".webp");
    const photo = entry.photo!;
    if (entry.rights === "cleared") {
      expect(lstatSync(join("public/photos", photo)).isFile()).toBe(true);
      continue;
    }
    expect(publicNames.has(photo), `${photo} must not exist anywhere under public/`).toBe(false);
  }
});
