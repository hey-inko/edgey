import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { runDemoOrders } from "./demo-orders-fixture.mjs";
import { localDbConnection, stagingDbConnection } from "./staging-db-connection.mjs";

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
  return flags.staging ? stagingDbConnection(ref, env) : localDbConnection(env);
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
