import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const project = "abcdefghijklmnopqrst";
const pooler = `postgresql://postgres.${project}:hidden-password@aws-0-eu-north-1.pooler.supabase.com:5432/postgres`;
const hostedFixture = (url: string, ref = project) =>
  spawnSync(process.execPath, ["scripts/apply-hosted-staging-fixture.mjs", "--project-ref", ref], {
    env: { NODE_ENV: "test", EDGEY_STAGING_DB_URL: url },
    encoding: "utf8",
  });

test("refuses a hosted fixture without an explicit project reference", () => {
  const result = hostedFixture(`postgresql://postgres:secret@db.${project}.supabase.co/postgres`, "");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Pass --project-ref");
});

test.each([
  ["postgresql://postgres:hidden-password@localhost:54322/postgres", "must use the direct host or the session pooler"],
  ["postgresql://postgres:hidden-password@db.zzzzzzzzzzzzzzzzzzzz.supabase.co/postgres", "must use the direct host or the session pooler"],
  [`postgresql://postgres:hidden-password@db.${project}.supabase.co.attacker.example/postgres`, "must use the direct host or the session pooler"],
  [`postgresql://postgres:hidden-password@db.${project}.supabase.co:6543/postgres`, "must use the direct host or the session pooler"],
  [`postgresql://postgres.${project}:hidden-password@db.${project}.supabase.co/postgres`, "must use the direct host or the session pooler"],
  [`postgresql://postgres:hidden-password@db.${project}.supabase.co/postgres?sslmode=disable`, "no query string or fragment"],
] as const)("refuses a nonmatching or unsafe connection URL before connecting", (url, message) => {
  const result = hostedFixture(url);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain("hidden-password");
});

test("requires a downloaded certificate for the confirmed hosted project", () => {
  const result = hostedFixture(`postgresql://postgres:hidden-password@db.${project}.supabase.co/postgres`);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("EDGEY_STAGING_DB_CA_FILE");
  expect(result.stderr).not.toContain("hidden-password");
});

test.each([
  ["direct URL with the default port", `postgres://postgres:hidden-password@db.${project}.supabase.co/postgres`],
  ["session pooler URL", pooler],
])("configures verified TLS for a %s without connecting", (_target, url) => {
  const { stagingDbConnection } = createRequire(import.meta.url)("../../scripts/staging-db-connection.mjs");
  const directory = mkdtempSync(join(tmpdir(), "edgey-staging-ca-"));
  try {
    const path = join(directory, "staging.crt");
    const ca = "-----BEGIN CERTIFICATE-----\ntest CA contents\n-----END CERTIFICATE-----\n";
    writeFileSync(path, ca);
    expect(stagingDbConnection(project, { EDGEY_STAGING_DB_URL: url, EDGEY_STAGING_DB_CA_FILE: path }))
      .toEqual({ connectionString: url, ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 10_000 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each([
  ["fixture import", ["scripts/apply-hosted-staging-fixture.mjs"]],
  ["demo load", ["scripts/demo-orders.mjs", "load", "--staging"]],
  ["demo cleanup", ["scripts/demo-orders.mjs", "clean", "--staging"]],
  ["catalogue dry run", ["scripts/sync-catalogue.mjs", "--staging"]],
  ["catalogue apply", ["scripts/sync-catalogue.mjs", "--staging", "--apply"]],
] as const)("%s through the session pooler", (_command, args) => {
  test.each([
    ["matching ref and session port (requires a CA file)", pooler, "Set EDGEY_STAGING_DB_CA_FILE"],
    ["wrong ref", pooler.replace(project, "zzzzzzzzzzzzzzzzzzzz"), "must use the direct host or the session pooler"],
    ["direct username", pooler.replace(`.${project}`, ""), "must use the direct host or the session pooler"],
    ["transaction port", pooler.replace(":5432", ":6543"), "must use the direct host or the session pooler"],
    ["missing port", pooler.replace(":5432", ""), "must use the direct host or the session pooler"],
    ["look-alike host", pooler.replace(".supabase.com", ".supabase.com.evil.example"), "must use the direct host or the session pooler"],
    ["bare pooler domain", pooler.replace("aws-0-eu-north-1.", ""), "must use the direct host or the session pooler"],
    ["wrong database", pooler.replace(/\/postgres$/, "/other"), "no query string or fragment"],
    ["missing password", pooler.replace(":hidden-password", ""), "no query string or fragment"],
    ["TLS override", pooler + "?sslmode=disable", "no query string or fragment"],
    ["fragment", pooler + "#", "no query string or fragment"],
  ])("%s", (_scenario, url, message) => {
    const result = spawnSync(process.execPath, [...args, "--project-ref", project], {
      env: { NODE_ENV: "test", EDGEY_STAGING_DB_URL: url },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain("hidden-password");
  });
});

test.each([
  [[], ""],
  [["--apply"], ""],
  [["--staging", "--apply"], ""],
  [["--staging", "--project-ref", "bad"], ""],
  [["--local", "--staging", "--project-ref", project], ""],
  [["--local", "--project-ref", project], ""],
  [["--local", "--apply=false"], ""],
  [["--local", "--apply"], pooler],
  [["--local", "--apply"], "postgresql://localhost/postgres?host=db.example.test"],
] as const)("catalogue sync refuses unsupported or unsafe targets (%j)", (args, url) => {
  const result = spawnSync(process.execPath, ["scripts/sync-catalogue.mjs", ...args], {
    env: { NODE_ENV: "test", SUPABASE_DB_URL: url }, encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(url ? "must be a loopback Postgres URL" : "Usage: pnpm catalogue:sync");
  expect(result.stderr).not.toContain("hidden-password");
});

test.each([
  "postgresql://postgres:hidden-password@db.example.test/postgres",
  "postgresql://postgres:hidden-password@localhost:54322/postgres?host=db.example.test",
  "not-a-database-url",
])("the local fixture rejects hosted addresses and connection-string overrides", (url) => {
  const result = spawnSync(process.execPath, ["scripts/apply-staging-fixture.mjs"], {
    env: { NODE_ENV: "test", SUPABASE_DB_URL: url },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("must be a loopback Postgres URL without query parameters");
  expect(result.stderr).not.toContain("hidden-password");
});
