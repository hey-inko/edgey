// Loads .env.local for scripts and tests without overriding the real environment.
import { existsSync } from "node:fs";

const file = new URL("../.env.local", import.meta.url);
if (existsSync(file)) process.loadEnvFile(file);

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is not set. Run: pnpm db:start && pnpm db:env");
  return value;
}
