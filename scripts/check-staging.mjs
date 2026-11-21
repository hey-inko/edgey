import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { parseArgs, parseEnv } from "node:util";

function hostedHttps(value) {
  const url = URL.parse(value);
  return url?.protocol === "https:" && !url.username && !url.password &&
    url.hostname.includes(".") && !isIP(url.hostname) && !/\.(localhost|local)\.?$/i.test(url.hostname)
    ? url : null;
}

function hostedOrigin(value) {
  const url = hostedHttps(value);
  return url?.pathname === "/" && !url.search && !url.hash ? url : null;
}

function supabaseKey(value, prefix, role, projectRef) {
  if (new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value)) return true;
  const parts = value.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims?.role === role && (!projectRef || claims.ref === projectRef);
  } catch {
    return false;
  }
}

function stagingIssues(env) {
  const issues = [];
  const required = (name, source, valid, expected) => {
    const value = env[name];
    if (!value?.trim()) issues.push(`${name} is missing. ${source}`);
    else if (value !== value.trim() || !valid(value)) issues.push(`${name}: ${expected}`);
  };
  const supabaseUrl = (value) => hostedOrigin(value)?.host.match(/^([a-z0-9]{20})\.supabase\.co$/);
  const projectRef = supabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? "")?.[1];
  const mailbox = (value) =>
    value.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$/i.test(value);
  const from = (value) => !/[\r\n]/.test(value) && mailbox(value.match(/^[^<>]+ <([^<>]+)>$/)?.[1] ?? value);

  required("NEXT_PUBLIC_SITE_URL", "Set the canonical HTTPS origin of the staging storefront.",
    (value) => {
      const url = hostedOrigin(value);
      return url && !url.hostname.endsWith(".supabase.co");
    },
    "use the staging storefront HTTPS origin without a path, query, or credentials.");
  required("NEXT_PUBLIC_SUPABASE_URL", "Copy the staging Supabase project URL.",
    supabaseUrl, "use the HTTPS project API origin (<project-ref>.supabase.co), not a local or database URL.");
  required("NEXT_PUBLIC_SUPABASE_ANON_KEY", "Copy the staging Supabase publishable or legacy anon key.",
    (value) => supabaseKey(value, "sb_publishable", "anon", projectRef),
    "use the staging project's public publishable or anon key. Never put a secret or service-role key here.");
  required("SUPABASE_SERVICE_ROLE_KEY", "Copy the staging Supabase server-only secret or legacy service-role key.",
    (value) => supabaseKey(value, "sb_secret", "service_role", projectRef),
    "use the staging project's server-only secret or service-role key.");
  required("EDGEY_REQUEST_HASH_KEY", "Generate a stable server-only random key of at least 32 bytes.",
    (value) => Buffer.byteLength(value) >= 32 && !/[\r\n]/.test(value), "use a server-only random key of at least 32 bytes.");
  required("STRIPE_SECRET_KEY", "Copy the secret key from the isolated Stripe sandbox.",
    (value) => /^sk_test_[A-Za-z0-9]+$/.test(value), "use a Stripe sandbox secret key (sk_test_…), never a live or restricted key for acceptance.");
  required("STRIPE_WEBHOOK_SECRET", "Copy the signing secret from the staging sandbox webhook endpoint.",
    (value) => /^whsec_[A-Za-z0-9]+$/.test(value), "use the endpoint's signing secret (whsec_…).");
  required("CRON_SECRET", "Generate a separate server-only bearer token for Vercel Cron.",
    (value) => /^[A-Za-z0-9._~-]{32,}$/.test(value), "use at least 32 URL-safe characters for the server-only bearer token.");
  if (env.EMAIL_PROVIDER && env.EMAIL_PROVIDER !== "resend") {
    issues.push("EMAIL_PROVIDER: use resend for hosted staging. The file provider is local only.");
  }
  required("RESEND_API_KEY", "Copy the staging Resend sending key.",
    (value) => /^re_[A-Za-z0-9_-]+$/.test(value), "use a Resend API key (re_…).");
  required("EMAIL_FROM", "Set a sender on the verified staging Resend domain.",
    from, "use one sender address, optionally in the form Edgey <orders@example.com>.");
  required("REQUEST_STAFF_EMAIL", "Set the single controlled staging request mailbox.",
    mailbox, "use one plain email address controlled by staging staff.");
  required("EDGEY_PRIVACY_NOTICE_URL", "Publish the privacy notice for hosted forms.",
    hostedHttps, "use the published HTTPS privacy-notice URL.");
  required("EDGEY_PUBLIC_REQUESTS_ENABLED", "Set it to true only after the privacy and retention gates have passed.",
    (value) => value === "true", "set it to true after privacy and retention sign-off; trial intake and buyer sign-in are otherwise closed.");

  for (const name of [
    "SUPABASE_DB_URL", "EDGEY_STAGING_DB_URL", "EDGEY_STAGING_DB_CA_FILE", "EDGEY_LOCAL_STAFF_PASSWORD",
    "EMAIL_OUTBOX_DIR", "PLAYWRIGHT_PORT", "SUPABASE_ACCESS_TOKEN", "VERCEL_TOKEN",
  ]) {
    if (env[name]?.trim()) issues.push(`${name} is for operator tooling or local use only. Remove it from the staging deployment configuration.`);
  }
  return issues;
}

function checkStaging() {
  const usage = "Usage: pnpm staging:check [--from <staging.env>]";
  let options;
  try {
    options = parseArgs({ options: { from: { type: "string" }, help: { type: "boolean" } } });
  } catch {
    console.error(usage);
    return false;
  }
  if (options.values.help) {
    console.log(usage);
    return true;
  }

  let env = process.env;
  if (options.values.from !== undefined) {
    try {
      env = parseEnv(readFileSync(options.values.from, "utf8"));
    } catch {
      console.error("Could not read the staging environment file. Use a readable dotenv file.");
      return false;
    }
  }

  const issues = stagingIssues(env);
  if (issues.length) {
    console.error("Staging configuration needs attention:");
    for (const issue of issues) console.error("- " + issue);
    return false;
  }
  console.log("Staging configuration passed the local checks. Verify project isolation, provider settings and the deployed journey in docs/staging.md.");
  return true;
}

if (!checkStaging()) process.exitCode = 1;
