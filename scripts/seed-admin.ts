import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";

export function localAdminClient() {
  const envFile = new URL("../.env.local", import.meta.url);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = rawUrl && new URL(rawUrl);
  if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !key) {
    throw new Error("This seed only runs against local Supabase. Run pnpm db:start and pnpm db:env.");
  }
  return createClient<Database>(url.origin, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

type StaffRole = Database["public"]["Enums"]["staff_role"];
const roles = ["warehouse", "catalogue", "finance"] satisfies StaffRole[];

export async function createLocalAdminUser(role: StaffRole | "buyer", password: string = randomUUID()) {
  const db = localAdminClient();
  const email = `${role}-${randomUUID()}@example.test`;
  const result = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (result.error) throw new Error("Could not create a local test user.");
  const id = result.data.user.id;
  if (role !== "buyer") {
    const membership = await db.from("staff_members").insert({ user_id: id, role });
    if (membership.error) {
      await db.auth.admin.deleteUser(id);
      throw new Error("Could not assign the local test user's role.");
    }
  }
  return { email, password, id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const password = process.env.EDGEY_LOCAL_STAFF_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error("Set EDGEY_LOCAL_STAFF_PASSWORD to a disposable local-only password of at least 12 characters.");
  }
  for (const role of roles) {
    const { email } = await createLocalAdminUser(role, password);
    console.log(`${role}: ${email}`);
  }
}
