// Applies supabase/fixtures/staging.sql: published test variants with stock.
// Local development and CI only.
import { readFileSync } from "node:fs";
import pg from "pg";
import { requireEnv } from "./env.mjs";

const url = requireEnv("SUPABASE_DB_URL");
const host = new URL(url).hostname;
const isLocal = host === "127.0.0.1" || host === "localhost";
if (!isLocal) {
  console.error("Refusing to apply the staging fixture to " + host + ". This fixture is for local development and CI only.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(readFileSync(new URL("../supabase/fixtures/staging.sql", import.meta.url), "utf8"));
  const { rows } = await client.query(
    "select count(*)::int as published from public.variants where publication_status = 'published'",
  );
  console.log("Staging fixture applied. Published variants: " + rows[0].published);
} finally {
  await client.end();
}
