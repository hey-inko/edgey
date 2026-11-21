import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { runDemoOrders } from "./demo-orders-fixture.mjs";

const usage = "Pass --local or --staging --project-ref <staging-project-ref>.";

export function demoConnection(args, env) {
  let flags;
  try {
    flags = parseArgs({ args, options: {
      local: { type: "boolean" }, staging: { type: "boolean" }, "project-ref": { type: "string" },
    } }).values;
  } catch {
    throw new Error(usage);
  }
  const ref = flags["project-ref"];
  if (Boolean(flags.local) === Boolean(flags.staging) || (flags.local && ref !== undefined) ||
      (flags.staging && !/^[a-z0-9]{20}$/.test(ref ?? ""))) {
    throw new Error(usage);
  }
  const url = URL.parse((flags.local ? env.SUPABASE_DB_URL : env.EDGEY_STAGING_DB_URL) ?? "");
  const postgres = url && ["postgres:", "postgresql:"].includes(url.protocol) &&
    !url.href.includes("?") && !url.href.includes("#");
  if (flags.local) {
    if (!postgres || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("SUPABASE_DB_URL must be a loopback Postgres URL without query parameters or a fragment.");
    }
    return { connectionString: url.href, ssl: false, connectionTimeoutMillis: 10_000 };
  }
  if (!postgres || url.hostname !== `db.${ref}.supabase.co` || !["", "5432"].includes(url.port) ||
      url.pathname !== "/postgres" || url.username !== "postgres" || !url.password) {
    throw new Error("EDGEY_STAGING_DB_URL must be the direct Postgres URL for the confirmed staging project, with a password and no query string.");
  }
  let ca;
  try {
    ca = readFileSync(env.EDGEY_STAGING_DB_CA_FILE ?? "", "utf8");
    if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error();
  } catch {
    throw new Error("Set EDGEY_STAGING_DB_CA_FILE to the server root certificate from that staging Supabase project.");
  }
  return { connectionString: url.href, ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 10_000 };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  let connection;
  try {
    if (mode !== "load" && mode !== "clean") throw new Error("Select the demo:orders or demo:orders:clean command.");
    if (args.includes("--local")) await import("./env.mjs");
    connection = demoConnection(args, process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const db = new pg.Client(connection);
  try {
    await db.connect();
    console.log(await runDemoOrders(db, mode));
  } catch (error) {
    const code = /^[0-9A-Z]{5}$/.test(error?.code ?? "") ? ` (SQLSTATE ${error.code})` : "";
    console.error(error.name === "DemoOrdersRefusal" ? error.message :
      `Demo order command failed${code}. Check the target, database access and migrations; no partial changes were committed.`);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
