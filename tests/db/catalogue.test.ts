import { afterAll, beforeAll, expect, test } from "vitest";
import { Client } from "pg";

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await db.connect();
  await db.query("set role anon");
});

afterAll(() => db?.end());

type Hit = { sku: string; match_type: string; matched_code: string | null; requires_choice: boolean };
const search = async (query: string) =>
  (await db.query<Hit>("select * from public.search_blades($1)", [query])).rows;

test.each([
  ["  eDg - z10 ", "EDG-Z10"],
  [" 3910.301 ", "3910301"],
  [" 391 360 ", "391-360"],
])("matches %j exactly and preserves the printed code", async (query, code) => {
  expect(await search(query)).toEqual([
    expect.objectContaining({ match_type: "exact", matched_code: code, requires_choice: false }),
  ]);
});

test("every exact configuration is returned and requires a choice", async () => {
  const hits = await search("SPB 0030");
  expect(hits.map(({ sku }) => sku)).toEqual(["EDG-MIM-A45", "EDG-MIM-A60"]);
  for (const hit of hits) expect(hit).toMatchObject({ match_type: "exact", requires_choice: true });
});

test("labels substrate and typo-tolerant brand/tool suggestions", async () => {
  const materials = await search("Foamex");
  expect(materials.slice(0, 2).map(({ sku }) => sku)).toEqual(["EDG-Z10", "EDG-SR6223"]);
  expect(materials.every(({ match_type }) => match_type === "suggested")).toBe(true);
  expect(await search("Zund oscilating")).toEqual([
    expect.objectContaining({ sku: "EDG-Z16", match_type: "suggested" }),
  ]);
});

test.each(["", "00000000", "5201345", "500-9802", "PRIV-Z10-ALIAS", "EDG-Z11", "EDG-MIM-A30"])(
  "excludes unknown, corrected, private, unverified and draft codes (%j)",
  async (query) => {
    expect(await search(query)).toEqual([]);
  },
);

test("the original Z71 item still matches", async () => {
  expect(await search("5006045")).toEqual([expect.objectContaining({ sku: "EDG-Z71", match_type: "exact" })]);
});

test("RLS excludes drafts and candidates even inside a visible family", async () => {
  const { rows: variants } = await db.query("select sku from public.variants order by sku");
  expect(variants.map(({ sku }) => sku)).toContain("EDG-MIM-A45");
  expect(variants.map(({ sku }) => sku)).not.toContain("EDG-MIM-A30");
  expect(variants.map(({ sku }) => sku)).not.toContain("EDG-Z11");

  const { rows: compatibility } = await db.query("select code, verification_state, is_private from public.compatibility");
  expect(compatibility).toContainEqual({ code: "3910301", verification_state: "approved", is_private: false });
  expect(compatibility.every(({ verification_state, is_private }) => verification_state === "approved" && !is_private)).toBe(true);
  expect(compatibility.map(({ code }) => code)).not.toContain("500-9802");
  expect(compatibility.map(({ code }) => code)).not.toContain("PRIV-Z10-ALIAS");

  const { rows: brands } = await db.query("select slug from public.brands");
  expect(brands.map(({ slug }) => slug)).not.toContain("graphtec");
});

test("column grants keep stock counts and supplier identifiers private", async () => {
  await expect(db.query("select supplier_part_number from public.variants")).rejects.toMatchObject({ code: "42501" });
  await expect(db.query("select stock_on_hand from public.variants")).rejects.toMatchObject({ code: "42501" });
});

test("the draft import has exactly 23 families and preserves corrected references", async () => {
  await db.query("reset role");
  try {
    const { rows } = await db.query(`
      select
        (select count(*)::int from public.products) as families,
        (select count(*)::int from public.variants where publication_status = 'draft') as drafts,
        (select bool_and(stock_on_hand = 0 and stock_reserved = 0) from public.variants
         where publication_status = 'draft') as draft_stock_is_zero
    `);
    expect(rows).toEqual([{ families: 23, drafts: 19, draft_stock_is_zero: true }]);
    const { rows: mapped } = await db.query(`
      select v.sku, c.code from public.variants v
      join public.compatibility c on c.variant_id = v.id
      where c.code in ('5201345', '5006045', '42442525', '42438135', '42443366', '42449504')
      order by v.sku
    `);
    expect(mapped).toEqual([
      { sku: "EDG-SR6224", code: "42438135" },
      { sku: "EDG-SR6315", code: "42449504" },
      { sku: "EDG-Z71", code: "5006045" },
    ]);
  } finally {
    await db.query("set role anon");
  }
});

test("unpublishing a variant or withdrawing a mapping takes effect immediately", async () => {
  await db.query("reset role");
  await db.query("begin");
  try {
    await db.query("update public.variants set publication_status = 'draft' where sku = 'EDG-Z10'");
    await db.query("update public.compatibility set verification_state = 'candidate' where code = '3910306'");
    await db.query("set local role anon");
    expect(await search("3910301")).toEqual([]);
    expect(await search("3910306")).toEqual([]);
    expect(await search("EDG-Z16")).toHaveLength(1);
  } finally {
    await db.query("rollback");
    await db.query("set role anon");
  }
});
