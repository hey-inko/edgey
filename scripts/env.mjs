// Loads .env.local for scripts and tests without overriding the real environment.
import { existsSync, readFileSync } from "node:fs";

const file = new URL("../.env.local", import.meta.url);
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is not set. Run: pnpm db:start && pnpm db:env");
  return value;
}
