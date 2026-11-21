import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const projectRef = "abcdefghijklmnopqrst";
const staging = {
  NEXT_PUBLIC_SITE_URL: "https://staging.example.test",
  NEXT_PUBLIC_SUPABASE_URL: `https://${projectRef}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_example",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_example",
  EDGEY_REQUEST_HASH_KEY: "a".repeat(32),
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  CRON_SECRET: "b".repeat(32),
  RESEND_API_KEY: "re_example",
  EMAIL_FROM: "Edgey <orders@example.test>",
  REQUEST_STAFF_EMAIL: "staff@example.test",
  EDGEY_PRIVACY_NOTICE_URL: "https://staging.example.test/privacy",
  EDGEY_PUBLIC_REQUESTS_ENABLED: "true",
};
const checker = (env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, ["scripts/check-staging.mjs", ...args], { env: { NODE_ENV: "test", ...env }, encoding: "utf8" });

test("reports the missing settings together without reading the local environment file", () => {
  const result = checker({});
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Staging configuration needs attention");
  for (const name of Object.keys(staging)) expect(result.stderr).toContain(`${name} is missing.`);
  expect(result.stdout).toBe("");
});

test("accepts a valid staging snapshot and defaults to Resend without echoing values", () => {
  const result = checker(staging);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("passed the local checks");
  expect(result.stdout).toContain("Verify project isolation");
  expect(result.stdout).not.toContain(staging.SUPABASE_SERVICE_ROLE_KEY);
});

test("rejects local targets, live credentials and closed intake without exposing values", () => {
  const invalid = {
    NEXT_PUBLIC_SITE_URL: "https://staging.example.test/checkout",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_wrongly_public",
    SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_not_for_the_server",
    CRON_SECRET: "short-token",
    STRIPE_SECRET_KEY: "sk_live_never_print_me",
    STRIPE_WEBHOOK_SECRET: "not-a-signing-secret",
    EMAIL_PROVIDER: "file",
    EDGEY_PUBLIC_REQUESTS_ENABLED: "false",
    EDGEY_PRIVACY_NOTICE_URL: "http://staging.example.test/privacy",
    EDGEY_STAGING_DB_URL: "postgresql://postgres:never-echo@example.test/postgres",
  };
  const result = checker({ ...staging, ...invalid });
  expect(result.status).toBe(1);
  for (const name of Object.keys(invalid)) expect(result.stderr).toContain(name);
  for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "EDGEY_STAGING_DB_URL"] as const) {
    expect(result.stderr).not.toContain(invalid[name]);
  }
  expect(result.stderr).toContain("trial intake and buyer sign-in are otherwise closed");
});

test("distinguishes legacy anon and service-role keys and checks their project ref", () => {
  const legacy = (role: string, ref = projectRef) =>
    `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role, ref })).toString("base64url")}.example`;
  const env = {
    ...staging,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: legacy("anon"),
    SUPABASE_SERVICE_ROLE_KEY: legacy("service_role"),
  };
  expect(checker(env).status).toBe(0);
  expect(checker({ ...env, NEXT_PUBLIC_SUPABASE_ANON_KEY: env.SUPABASE_SERVICE_ROLE_KEY }).status).toBe(1);
  const result = checker({ ...env, SUPABASE_SERVICE_ROLE_KEY: legacy("service_role", "differentprojectrefx") });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("SUPABASE_SERVICE_ROLE_KEY");
});

test("an explicit dotenv snapshot cannot be filled by the calling shell", () => {
  const directory = mkdtempSync(join(tmpdir(), "edgey-staging-check-"));
  try {
    const file = join(directory, "deployment.env");
    writeFileSync(file, 'EMAIL_FROM="Edgey <orders@example.test>"\n', { mode: 0o600 });
    const partial = checker(staging, "--from", file);
    expect(partial.status).toBe(1);
    expect(partial.stderr).toContain("RESEND_API_KEY is missing.");
    expect(partial.stderr).not.toContain("EMAIL_FROM");

    writeFileSync(file, Object.entries(staging).map(([name, value]) => `${name}="${value}"`).join("\n"));
    expect(checker({ STRIPE_SECRET_KEY: "sk_live_not_the_snapshot" }, "--from", file).status).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bad CLI arguments and unreadable dotenv files fail without disclosing the path", () => {
  expect(checker({}, "--help").status).toBe(0);
  expect(checker({}, "--unsupported").status).toBe(1);
  const unreadable = checker({}, "--from", "/a/private/nonexistent/env");
  expect(unreadable.status).toBe(1);
  expect(unreadable.stderr).toContain("Could not read");
  expect(unreadable.stderr).not.toContain("/a/private");
});
