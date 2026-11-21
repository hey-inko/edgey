import { readFileSync } from "node:fs";

export function stagingDbConnection(projectRef, env) {
  const url = URL.parse(env.EDGEY_STAGING_DB_URL ?? "");
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/postgres" ||
      !url.password || url.href.includes("?") || url.href.includes("#")) {
    throw new Error("EDGEY_STAGING_DB_URL must be a Postgres URL for the confirmed staging project's postgres database, with a password and no query string or fragment.");
  }

  const direct = url.hostname === `db.${projectRef}.supabase.co` &&
    ["", "5432"].includes(url.port) && url.username === "postgres";
  const sessionPooler = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+pooler\.supabase\.com$/.test(url.hostname) &&
    url.port === "5432" && url.username === `postgres.${projectRef}`;
  if (!direct && !sessionPooler) {
    throw new Error("EDGEY_STAGING_DB_URL must use the direct host or the session pooler on port 5432 for the confirmed staging project.");
  }

  let ca;
  try {
    ca = readFileSync(env.EDGEY_STAGING_DB_CA_FILE ?? "", "utf8");
    if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error();
  } catch {
    throw new Error("Set EDGEY_STAGING_DB_CA_FILE to the server root certificate from the staging Supabase dashboard's Database Settings.");
  }
  return { connectionString: url.href, ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 10_000 };
}
