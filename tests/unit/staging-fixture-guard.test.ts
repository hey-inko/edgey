import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

const project = "abcdefghijklmnopqrst";
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
  "postgresql://postgres:hidden-password@localhost:54322/postgres",
  "postgresql://postgres:hidden-password@db.zzzzzzzzzzzzzzzzzzzz.supabase.co/postgres",
  `postgresql://postgres:hidden-password@db.${project}.supabase.co.attacker.example/postgres`,
  `postgresql://postgres:hidden-password@db.${project}.supabase.co/postgres?sslmode=disable`,
])("refuses a nonmatching or unsafe connection URL before connecting", (url) => {
  const result = hostedFixture(url);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("direct Postgres connection URL for the confirmed Supabase project");
  expect(result.stderr).not.toContain("hidden-password");
});

test("requires a downloaded certificate for the confirmed hosted project", () => {
  const result = hostedFixture(`postgresql://postgres:hidden-password@db.${project}.supabase.co/postgres`);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("EDGEY_STAGING_DB_CA_FILE");
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
