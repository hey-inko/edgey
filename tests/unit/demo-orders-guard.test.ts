import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

const ref = "abcdefghijklmnopqrst";
const password = "not-a-real-password";
const hosted = `postgresql://postgres:${password}@db.${ref}.supabase.co/postgres`;
const remote = ["--staging", "--project-ref", ref];

test.each([
  { args: [], env: {}, message: "Pass --local or --staging" },
  { args: ["--local", "--staging"], env: {}, message: "Pass --local or --staging" },
  { args: ["--staging"], env: {}, message: "Pass --local or --staging" },
  { args: ["--local"], env: { SUPABASE_DB_URL: hosted }, message: "must be a loopback Postgres URL" },
  { args: ["--local"], env: { SUPABASE_DB_URL: "postgres://localhost/db?host=other" }, message: "must be a loopback Postgres URL" },
  { args: remote, env: { EDGEY_STAGING_DB_URL: hosted.replace(ref, "zzzzzzzzzzzzzzzzzzzz") }, message: "must be the direct Postgres URL" },
  { args: remote, env: { EDGEY_STAGING_DB_URL: hosted + "?sslmode=disable" }, message: "must be the direct Postgres URL" },
  { args: remote, env: { EDGEY_STAGING_DB_URL: hosted.replace(".supabase.co", ".supabase.co.example") }, message: "must be the direct Postgres URL" },
  { args: remote, env: { EDGEY_STAGING_DB_URL: hosted, EDGEY_STAGING_DB_CA_FILE: "" }, message: "Set EDGEY_STAGING_DB_CA_FILE" },
])("rejects unsafe arguments before connecting for load and cleanup ($message)", ({ args, env, message }) => {
  for (const mode of ["load", "clean"]) {
    const result = spawnSync(process.execPath, ["scripts/demo-orders.mjs", mode, ...args], {
      env: { ...env, NODE_ENV: "test" }, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain(password);
  }
});
