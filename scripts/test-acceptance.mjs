import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { startStripeApi } from "../tests/acceptance/stripe-api.mjs";

const workdir = await mkdtemp(join(tmpdir(), "edgey-acceptance-"));
const projectId = "edgey-acceptance-" + randomBytes(4).toString("hex");
const secret = () => randomBytes(32).toString("hex");
const runtime = Object.fromEntries([
  "PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "CI",
  "PNPM_HOME", "COREPACK_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PLAYWRIGHT_BROWSERS_PATH",
  "EDGEY_NET30_RENDERS",
].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
const docker = Object.fromEntries(["DOCKER_HOST", "DOCKER_CONFIG", "XDG_RUNTIME_DIR"]
  .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
const supabase = (args, options) => execFileSync(
  "pnpm", ["exec", "supabase", "--workdir", workdir, ...args], { ...options, env: { ...runtime, ...docker } },
);
async function localPorts(count) {
  const sockets = Array.from({ length: count }, () => createServer().listen(0, "0.0.0.0"));
  try {
    await Promise.all(sockets.map((socket) => once(socket, "listening")));
    return sockets.map((socket) => socket.address().port);
  } finally {
    await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve))));
  }
}

let started = false;
let stripe;
try {
  const [appPort, apiPort, dbPort, mailPort] = await localPorts(4);
  const baseURL = `http://127.0.0.1:${appPort}`;
  const portMap = { 54321: apiPort, 54322: dbPort, 54324: mailPort };
  const config = await readFile("supabase/config.toml", "utf8");
  const directory = join(workdir, "supabase");
  await cp("supabase", directory, {
    recursive: true,
    filter: (path) => !/[/\\]\.(temp|branches)([/\\]|$)/.test(path),
  });
  await writeFile(join(directory, "config.toml"), config
    .replace(/^project_id = ".*"$/m, `project_id = "${projectId}"`)
    .replace(/^port = (5432[124])$/gm, (_, port) => "port = " + portMap[port])
    .replace("http://127.0.0.1:3100/auth/confirm", baseURL + "/auth/confirm"));

  started = true;
  supabase(["start"], { stdio: ["ignore", "ignore", "inherit"] });
  const status = parseEnv(supabase(["status", "-o", "env"], { encoding: "utf8" }));
  if (!status.DB_URL || !status.API_URL || !status.PUBLISHABLE_KEY || !status.SECRET_KEY ||
    [status.DB_URL, status.API_URL].some((value) => new URL(value).hostname !== "127.0.0.1")) {
    throw new Error("The isolated local Supabase stack did not supply loopback connection settings.");
  }
  stripe = await startStripeApi();
  const clock = join(workdir, "dispatch-clock");
  await writeFile(clock, "2026-07-07T14:29:00Z");
  const env = {
    ...runtime,
    VERCEL: "",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SITE_URL: baseURL,
    NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: status.PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SECRET_KEY,
    SUPABASE_DB_URL: status.DB_URL,
    EDGEY_REQUEST_HASH_KEY: secret(),
    STRIPE_SECRET_KEY: `sk_test_${secret()}`,
    STRIPE_WEBHOOK_SECRET: `whsec_${secret()}`,
    CRON_SECRET: secret(),
    EMAIL_PROVIDER: "file",
    RESEND_API_KEY: "",
    EMAIL_FROM: "Edgey Acceptance <orders@example.test>",
    EMAIL_OUTBOX_DIR: join(workdir, "outbox"),
    REQUEST_STAFF_EMAIL: "staff@example.test",
    EDGEY_PRIVACY_NOTICE_URL: "",
    EDGEY_PUBLIC_REQUESTS_ENABLED: "",
    ACCEPTANCE_BASE_URL: baseURL,
    ACCEPTANCE_DB_PORT: String(dbPort),
    ACCEPTANCE_STRIPE_URL: stripe.url,
    ACCEPTANCE_CLOCK_FILE: clock,
  };
  const run = (args) => execFileSync("pnpm", args, { env, stdio: "inherit" });
  run(["db:fixture"]);
  run(["exec", "vitest", "run", "tests/db/net30-invoicing.test.ts"]);
  run(["build"]);
  const result = await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "playwright", "test", "--config", "playwright.acceptance.config.ts", ...process.argv.slice(2)], { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = result;
} finally {
  if (stripe) await stripe.close();
  try {
    if (started) supabase(["stop", "--no-backup"], { stdio: ["ignore", "ignore", "inherit"] });
  } finally {
    await rm(workdir, { force: true, recursive: true });
  }
}
