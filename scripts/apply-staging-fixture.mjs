// Applies supabase/fixtures/staging.sql: published test variants with stock.
// Local development and CI only.
import { readFileSync } from "node:fs";
import pg from "pg";
import { requireEnv } from "./env.mjs";

const url = URL.parse(requireEnv("SUPABASE_DB_URL"));
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) || url.search || url.hash) {
  console.error("Refusing to apply the local fixture: SUPABASE_DB_URL must be a loopback Postgres URL without query parameters.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url.href });
await client.connect();
try {
  await client.query("begin");
  await client.query(readFileSync(new URL("../supabase/fixtures/staging.sql", import.meta.url), "utf8"));
  const { rows } = await client.query(
    "select count(*)::int as published from public.variants where publication_status = 'published'",
  );
  await client.query("commit");
  console.log("Staging fixture applied. Published variants: " + rows[0].published);
} finally {
  await client.end();
}
