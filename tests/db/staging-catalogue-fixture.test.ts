import { Client } from "pg";
import { expect, test } from "vitest";

test("the public staging catalogue preserves the four design identities and Appendix A prices", async () => {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString || !["127.0.0.1", "localhost"].includes(new URL(connectionString).hostname)) {
    throw new Error("Run pnpm db:start && pnpm db:env && pnpm db:fixture against local Supabase.");
  }
  const db = new Client({ connectionString });
  await db.connect();
  try {
    await db.query("set role anon");
    const products = [
      ["3910301", "EDG-Z10", "Flat-stock drag blade", "drag", "drag-line.svg", "coral", 2250, 1995, 1750],
      ["3910306", "EDG-Z16", "Oscillating blade", "oscillating", "oscillating-line.svg", "cyan", 2150, 1850, 1595],
      ["G42437293", "EDG-SR6223", "Round-shank blade", "oscillating", "cylinder-line.svg", "lime", 2550, 2250, 1995],
      ["3910335", "EDG-Z50", "Decagonal rotary blade", "rotary", "rotary-line.svg", "violet", 3800, 3400, 3000],
    ];
    for (const [code, sku, name, tool_category, drawing, proof, price_1_4_pence, price_5_9_pence, price_10_plus_pence] of products) {
      const { rows } = await db.query(`
        select hit.sku, hit.match_type, hit.matched_code, p.name, p.tool_category,
          p.media->>'drawing' as drawing, p.media->>'proof' as proof,
          v.price_1_4_pence, v.price_5_9_pence, v.price_10_plus_pence
        from public.search_blades($1) hit
        join public.variants v on v.sku = hit.sku
        join public.products p on p.id = v.product_id
      `, [code]);
      expect(rows).toEqual([{
        sku, name, tool_category, drawing, proof, price_1_4_pence, price_5_9_pence, price_10_plus_pence,
        match_type: "exact", matched_code: code,
      }]);
    }
  } finally {
    await db.end();
  }
});
