import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pg from "pg";

async function applyHostedFixture() {
  let projectRef;
  try {
    projectRef = parseArgs({ options: { "project-ref": { type: "string" } } }).values["project-ref"];
  } catch {
    console.error("Usage: pnpm db:fixture:staging --project-ref <staging-project-ref>");
    return false;
  }
  if (!/^[a-z0-9]{20}$/.test(projectRef ?? "")) {
    console.error("Pass --project-ref with the isolated staging project's reference from its dashboard.");
    return false;
  }

  const url = URL.parse(process.env.EDGEY_STAGING_DB_URL ?? "");
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== `db.${projectRef}.supabase.co` || !["", "5432"].includes(url.port) ||
      url.pathname !== "/postgres" || url.username !== "postgres" || !url.password || url.search || url.hash) {
    console.error("EDGEY_STAGING_DB_URL must be the direct Postgres connection URL for the confirmed Supabase project, with a password and no query string.");
    return false;
  }

  let ca;
  try {
    ca = readFileSync(process.env.EDGEY_STAGING_DB_CA_FILE ?? "", "utf8");
    if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error();
  } catch {
    console.error("Set EDGEY_STAGING_DB_CA_FILE to the server root certificate downloaded from the staging Supabase dashboard.");
    return false;
  }

  let client;
  try {
    client = new pg.Client({
      connectionString: url.href,
      ssl: { ca, rejectUnauthorized: true },
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local lock_timeout = '10s'");
    await client.query("lock table public.products in share row exclusive mode");
    const { rows: [state] } = await client.query(`
      select not (
        exists (select 1 from public.products) or
        exists (select 1 from public.orders) or
        exists (select 1 from public.enquiries) or
        exists (select 1 from public.trial_requests) or
        exists (select 1 from public.trade_applications) or
        exists (select 1 from auth.users)
      ) as empty
    `);
    if (!state.empty) {
      await client.query("rollback");
      console.error("Refusing to seed a non-empty database. Use a fresh, migrated staging project before adding users or taking orders.");
      return false;
    }
    await client.query(readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8"));
    await client.query(readFileSync(new URL("../supabase/fixtures/staging.sql", import.meta.url), "utf8"));
    await client.query("commit");
    console.log("Loaded the test catalogue and stock into the confirmed staging project.");
    return true;
  } catch (error) {
    const code = typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? ` (SQLSTATE ${error.code})` : "";
    console.error(`Could not apply the hosted staging fixture${code}. Check the target, database credentials, TLS certificate, network and migrations.`);
    return false;
  } finally {
    await client?.end().catch(() => {});
  }
}

if (!await applyHostedFixture()) process.exitCode = 1;
