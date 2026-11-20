// Writes .env.local from the running local Supabase stack.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], { encoding: "utf8" });
const status = Object.fromEntries(
  [...output.matchAll(/^([A-Z_]+)="?([^"\n]*)"?$/gm)].map((match) => [match[1], match[2]]),
);
const anonKey = status.PUBLISHABLE_KEY || status.ANON_KEY;
if (!status.API_URL || !anonKey || !status.DB_URL) {
  console.error("Could not read the local stack. Is it running? Try: pnpm db:start");
  process.exit(1);
}
writeFileSync(
  new URL("../.env.local", import.meta.url),
  [
    "NEXT_PUBLIC_SUPABASE_URL=" + status.API_URL,
    "NEXT_PUBLIC_SUPABASE_ANON_KEY=" + anonKey,
    "SUPABASE_DB_URL=" + status.DB_URL,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log("Wrote .env.local for " + status.API_URL);
