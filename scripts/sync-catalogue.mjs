import { parseArgs } from "node:util";
import pg from "pg";
import { runCatalogueSync } from "./catalogue-sync.mjs";
import { localDbConnection, stagingDbConnection } from "./staging-db-connection.mjs";

const usage = "Usage: pnpm catalogue:sync (--local | --staging --project-ref <project-ref>) [--apply]";

async function main() {
  let flags;
  try {
    flags = parseArgs({ options: {
      local: { type: "boolean" },
      staging: { type: "boolean" },
      "project-ref": { type: "string" },
      apply: { type: "boolean" },
    } }).values;
  } catch {
    console.error(usage);
    return false;
  }

  const ref = flags["project-ref"];
  if (Boolean(flags.local) === Boolean(flags.staging) || (flags.local && ref !== undefined) ||
      (flags.staging && !/^[a-z0-9]{20}$/.test(ref ?? ""))) {
    console.error(usage);
    return false;
  }
  let connection;
  try {
    if (flags.local) await import("./env.mjs");
    connection = flags.local ? localDbConnection(process.env) : stagingDbConnection(ref, process.env);
  } catch (error) {
    console.error(error.message);
    return false;
  }
  const db = new pg.Client(connection);
  try {
    await db.connect();
    const plan = await runCatalogueSync(db, { apply: flags.apply });
    console.log(`${flags.apply ? "Applied" : "Dry run"}: ${flags.local ? "local Supabase" : "hosted project " + ref}`);
    for (const { action, kind, key, reason } of plan) {
      console.log(`${action} ${kind} ${JSON.stringify(key)}${reason ? " — " + JSON.stringify(reason) : ""}`);
    }
    const count = (action) => plan.filter((entry) => entry.action === action).length;
    console.log(`${count("ADD")} add, ${count("UPDATE")} update, ${count("KEEP")} keep, ${count("CONFLICT")} conflict. ${flags.apply ? "Conflicts were skipped." : "No changes were made."}`);
    return true;
  } catch (error) {
    const code = /^[0-9A-Z]{5}$/.test(error?.code ?? "") ? ` (SQLSTATE ${error.code})` : "";
    console.error(error?.code === "55P03"
      ? "Catalogue sync could not obtain safe locks. Retry when orders and staff edits are quiet."
      : `Catalogue sync failed${code}. Check the database connection, migrations and seed definition. No partial plan is applied.`);
    return false;
  } finally {
    await db.end().catch(() => {});
  }
}

if (!await main()) process.exitCode = 1;
