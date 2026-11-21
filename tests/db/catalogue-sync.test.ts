import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";

type PlanEntry = { action: string; kind: string; key: string; reason: string };
const { runCatalogueSync } = createRequire(import.meta.url)("../../scripts/catalogue-sync.mjs") as {
  runCatalogueSync(db: Client, options?: { apply?: boolean; seed?: string }): Promise<PlanEntry[]>;
};
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "edgey-catalogue-sync-"));
const supabase = (...args: string[]) => exec("pnpm", ["exec", "supabase", "--workdir", root, ...args], { timeout: 120_000 });
const seed = await readFile("supabase/seed.sql", "utf8");
const old = await readFile("tests/fixtures/old-catalogue.sql", "utf8");
let db: Client;
let connectionString: string;
let started = false;

beforeAll(async () => {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not assign a local database port.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const target = join(root, "supabase");
  await mkdir(target);
  await cp("supabase/migrations", join(target, "migrations"), { recursive: true });
  const config = (await readFile("supabase/config.toml", "utf8"))
    .replace(/^project_id = .*$/m, `project_id = "edgey-catalogue-sync-${randomBytes(4).toString("hex")}"`)
    .replace(/^port = 54322$/m, `port = ${address.port}`)
    .replace("[db.seed]\nenabled = true", "[db.seed]\nenabled = false");
  await writeFile(join(target, "config.toml"), config);
  started = true;
  await supabase("db", "start");
  connectionString = `postgresql://postgres:postgres@127.0.0.1:${address.port}/postgres`;
  db = new Client({ connectionString });
  await db.connect();
}, 120_000);

afterAll(async () => {
  try {
    await db?.end();
    if (started) await supabase("stop", "--no-backup");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

const catalogueTables = ["tool_categories", "substrates", "brands", "products", "variants", "compatibility",
  "variant_substrates"].map((name) => "public." + name);
const preservedTables = ["public.stock_movements", "public.orders", "public.order_items", "public.trial_requests",
  "public.trial_fulfilments", "public.trial_allocations", "public.enquiries", "public.staff_members",
  "public.staff_variant_costs", "public.staff_receipt_costs", "public.staff_variant_cost_audit", "auth.users"];
const allTables = [...catalogueTables, ...preservedTables, "private.variant_price_changes", "private.catalogue_sync_baselines"];
async function snapshot(tables = allTables) {
  const { rows } = await db.query<{ name: string; data: unknown[] }>(tables.map((table) =>
    `select '${table}' as name, coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)), '[]') as data from ${table} t`,
  ).join(" union all "));
  return Object.fromEntries(rows.map(({ name, data }) => [name, data]));
}
const writes = (plan: PlanEntry[]) => plan.filter(({ action }) => action === "ADD" || action === "UPDATE");
const line = (plan: PlanEntry[], kind: string, key: string) => plan.find((entry) => entry.kind === kind && entry.key === key);
const cli = (args: string[]) => exec(process.execPath, ["scripts/sync-catalogue.mjs", "--local", ...args],
  { env: { ...process.env, SUPABASE_DB_URL: connectionString } });

async function catalogueData(skus: string[] | null) {
  return (await db.query(`
    select v.sku, p.family_code, to_jsonb(p) - array['id','created_at','updated_at'] as family,
      to_jsonb(v) - array['id','product_id','created_at','updated_at','catalogue_updated_at'] as variant,
      array(select substrate from public.variant_substrates s where s.variant_id = v.id order by substrate) as materials,
      array(select to_jsonb(c) - array['id','variant_id','created_at','updated_at'] from public.compatibility c
        where c.variant_id = v.id order by c.code_normalised) as mappings
    from public.variants v join public.products p on p.id = v.product_id
    where $1::text[] is null or v.sku = any($1) order by v.sku
  `, [skus])).rows;
}

test("plans and syncs an old demo safely, refreshes only untouched drafts, and rolls back on refusal", async () => {
  await db.query("begin");
  await db.query(seed);
  const seeded = await catalogueData(null);
  await db.query("rollback");
  expect(seeded).toHaveLength(35);

  await db.query(old);
  const before = await snapshot();
  const plan = await runCatalogueSync(db);
  expect(await snapshot()).toEqual(before);
  const additions = plan.filter(({ action, kind }) => action === "ADD" && kind === "Variant").map(({ key }) => key);
  expect(additions).toHaveLength(27);
  expect(additions).toContain("EDG-SUM-TAN-45");
  expect(line(plan, "Variant", "EDG-Z10")).toMatchObject({ action: "CONFLICT", reason: expect.stringMatching(/staging demo.*order lines.*published/) });
  expect(line(plan, "Variant", "EDG-Z11")).toMatchObject({ action: "KEEP", reason: "not created by catalogue sync" });
  expect(line(plan, "Family", "EDG-Z28")).toMatchObject({ action: "CONFLICT", reason: "slug already belongs to EDG-LEGACY" });
  expect(line(plan, "Variant", "EDG-Z20")).toMatchObject({ action: "CONFLICT", reason: expect.stringContaining("SKU already belongs to edg z20 in EDG-OLD") });
  expect(line(plan, "Variant", "EDG-SUM-9802")).toMatchObject({ action: "CONFLICT", reason: "OEM reference 500-9802 already belongs to EDG-OLD" });
  expect(line(plan, "Variant", "EDG-Z17")).toMatchObject({ action: "CONFLICT", reason: "Alias BLD-SF217 already belongs to EDG-OLD" });
  expect(line(plan, "Variant", "EDG-DF113")).toMatchObject({ action: "CONFLICT", reason: "SKU matches a code on EDG-OLD" });
  expect(line(plan, "Alias", "EDG-OLD / OLD-DEMO-ALIAS")).toMatchObject({ action: "KEEP", reason: "not in repository; never removed" });
  expect(line(plan, "Variant material", "EDG-Z10 / foamex")).toMatchObject({ action: "KEEP" });
  expect(line(plan, "Material", "foamex")).toMatchObject({ action: "KEEP" });

  const { stdout } = await cli([]);
  expect(stdout).toContain("Dry run: local Supabase");
  const list = stdout.split("\n").slice(1, -2);
  expect(list).toContain('CONFLICT Variant "EDG-Z17" — "Alias BLD-SF217 already belongs to EDG-OLD"');
  const locked = new Client({ connectionString });
  await locked.connect();
  try {
    await locked.query("begin; lock table public.order_items in row exclusive mode");
    await expect(cli(["--apply"])).rejects.toMatchObject({ stderr: expect.stringContaining("could not obtain safe locks") });
    expect(await snapshot()).toEqual(before);
  } finally {
    await locked.end();
  }

  const applied = await cli(["--apply"]);
  expect(applied.stdout).toContain("Applied: local Supabase");
  expect(applied.stdout.split("\n").slice(1, -2)).toEqual(list);
  const imported = await catalogueData(additions);
  const expected = seeded.filter(({ sku }) => additions.includes(sku));
  expect(imported.filter(({ family_code }) => family_code !== "EDG-SUM-TAN"))
    .toEqual(expected.filter(({ family_code }) => family_code !== "EDG-SUM-TAN"));
  expect(imported.find(({ sku }) => sku === "EDG-SUM-TAN-45")).toMatchObject({
    family: { name: "Mixed demo and new family" }, variant: { publication_status: "draft", stock_on_hand: 0, stock_reserved: 0 },
  });
  const first = await snapshot();
  for (const [table, rows] of Object.entries(before)) {
    if (rows.length) expect(first[table]).toEqual(expect.arrayContaining(rows));
  }
  expect(await snapshot(preservedTables)).toEqual(Object.fromEntries(preservedTables.map((table) => [table, before[table]])));
  expect(writes(await runCatalogueSync(db, { apply: true }))).toEqual([]);
  expect(await snapshot()).toEqual(first);

  await db.query(`
    select private.apply_stock_movement('receive', 'staff-receive', id, 1, 0)
    from public.variants where sku = 'EDG-Z16';
    update public.variants set stock_on_hand = 0 where sku = 'EDG-Z16';
    update public.variants set stock_on_hand = 2, stock_reserved = 1 where sku = 'EDG-SR6315';
    insert into public.order_items (order_id, variant_id, sku, option_label, quantity, unit_price_pence, net_pence, tax_pence, gross_pence)
    select o.id, v.id, v.sku, 'Historical sale', 1, 100, 100, 20, 120 from public.orders o cross join public.variants v where v.sku = 'EDG-Z46';
    insert into public.trial_fulfilments (trial_request_id, state, recipient_name, address_line1, address_town,
      address_postcode, address_country, address_verified_at, address_verified_by, carrier, carrier_service, cancelled_at, cancelled_by)
    select r.id, 'cancelled', 'Trial recipient', '1 Test Lane', 'London', 'SW9 9ZZ', 'GB', now(), s.user_id,
      'Test carrier', 'Test service', now(), s.user_id from public.trial_requests r cross join public.staff_members s;
    insert into public.trial_allocations (trial_request_id, variant_id, quantity)
    select r.trial_request_id, v.id, 2 from public.trial_fulfilments r cross join public.variants v where v.sku = 'EDG-Z21';
    update public.compatibility c set verification_state = 'approved', approved_at = now()
    from public.variants v where v.id = c.variant_id and v.sku = 'EDG-Z1';
    update public.variants set rejected_at = now() where sku = 'EDG-Z2';
    update public.variants set publication_status = 'archived' where sku = 'EDG-Z52';
    update public.variants set tool = 'Staff tooling' where sku = 'EDG-GRP-CB15-45';
    update public.products set name = 'Staff family name' where family_code = 'EDG-Z50';
    delete from public.variant_substrates s using public.variants v
    where s.variant_id = v.id and s.substrate = 'correx' and v.sku = 'EDG-SR6223';
    insert into public.staff_variant_costs (variant_id, supplier_unit_minor, currency, landed_unit_pence, actor_id, recorded_at)
    select v.id, 175, 'GBP', 237, s.user_id, now() from public.variants v cross join public.staff_members s where v.sku = 'EDG-SR6224';
    update public.enquiries set matched_variant_id = v.id from public.variants v where v.sku = 'EDG-Z50';
  `);
  const protectedState = await snapshot();
  const refreshed = seed
    .replace(/^  \('EDG-Z71', 'edg-z71', .*$/m, (row) => row.replace(/, '\{.*\}', (\d+\),?)$/, `, '{"drawing":"sync-test.svg"}', $1`))
    .replace(/^  \('EDG-Z50', 'edg-z50', .*$/m, (row) => row.replace(/'[^']*', 'rotary'/, "'New seed family name', 'rotary'"))
    .replace(/^  \('EDG-Z71', 'EDG-Z71', .*$/m, (row) => row.replace(/, \d+, \d+, \d+, (\d+)\),$/, ", 3600, 3200, 2900, $1),"))
    .replace(/^  \('EDG-Z71', 'Z71', .*$/m, (row) => row.replace("false, null),", "false, 'Updated evidence note'),") +
      "\n  ('EDG-Z71', 'SYNC-PRIVATE', 'alias', 'zund', null, null, null, false, 'Staff-only candidate'),")
    .replace("('EDG-Z71', 're-board'), ('EDG-Z71', 'honeycomb-board'),", "('EDG-Z71', 'laminate'), ('EDG-Z71', 'honeycomb-board'),");

  const refreshPlan = await runCatalogueSync(db, { seed: refreshed });
  const reasons = [
    ["EDG-Z16", "stock movements"], ["EDG-SR6315", "stock on hand or reserved"],
    ["EDG-Z46", "order lines"], ["EDG-Z21", "trial allocations"], ["EDG-Z1", "approval or rejection history"],
    ["EDG-Z2", "approval or rejection history"], ["EDG-Z52", "archived"], ["EDG-GRP-CB15-45", "changed since last sync"],
    ["EDG-SR6223", "changed since last sync"], ["EDG-SR6224", "staff cost estimates"], ["EDG-Z50", "staff-matched enquiry"],
  ] as const;
  for (const [sku, reason] of reasons) {
    expect(line(refreshPlan, "Variant", sku)).toMatchObject({ action: "KEEP", reason: expect.stringContaining(reason) });
  }
  expect(line(refreshPlan, "Family", "EDG-Z50")).toMatchObject({ action: "KEEP", reason: "changed since last sync" });
  expect(line(refreshPlan, "Family", "EDG-Z71")).toMatchObject({ action: "UPDATE", reason: "media" });
  expect(line(refreshPlan, "Variant", "EDG-Z71")).toMatchObject({ action: "UPDATE", reason: expect.stringContaining("price_1_4_pence") });
  expect(line(refreshPlan, "Compatibility model", "EDG-Z71 / Z71")).toMatchObject({ action: "UPDATE", reason: "evidence_note" });
  expect(line(refreshPlan, "Alias", "EDG-Z71 / SYNC-PRIVATE")).toMatchObject({ action: "ADD" });
  expect(line(refreshPlan, "Variant material", "EDG-Z71 / laminate")).toMatchObject({ action: "ADD" });
  expect(line(refreshPlan, "Variant material", "EDG-Z71 / re-board")).toMatchObject({ action: "KEEP", reason: "not in repository; never removed" });
  await expect(runCatalogueSync(db, { apply: true, seed: refreshed.replace("3600, 3200, 2900", "-1, 3200, 2900") }))
    .rejects.toMatchObject({ code: "23514" });
  expect(await snapshot()).toEqual(protectedState);
  expect(await runCatalogueSync(db, { apply: true, seed: refreshed })).toEqual(refreshPlan);
  const [z71] = await catalogueData(["EDG-Z71"]);
  expect(z71).toMatchObject({ family: { media: { drawing: "sync-test.svg" } }, materials: ["honeycomb-board", "laminate", "re-board"],
    variant: { price_1_4_pence: 3600, publication_status: "draft", stock_on_hand: 0, stock_reserved: 0 },
    mappings: expect.arrayContaining([
      expect.objectContaining({ code: "SYNC-PRIVATE", verification_state: "candidate", is_private: true }),
      expect.objectContaining({ code: "Z71", verification_state: "candidate", evidence_note: "Updated evidence note" }),
    ]),
  });
  expect(await snapshot(preservedTables)).toEqual(Object.fromEntries(preservedTables.map((table) => [table, protectedState[table]])));
  expect((await catalogueData(["EDG-Z50"]))[0].family.name).toBe("Staff family name");
  expect(writes(await runCatalogueSync(db, { apply: true, seed: refreshed }))).toEqual([]);
});
