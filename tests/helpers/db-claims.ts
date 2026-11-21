import type { Client } from "pg";

export async function setDbClaims(db: Client, role: string, sub?: string | null, steppedUp = false) {
  if (steppedUp) {
    if (role !== "authenticated" || !sub) throw new Error("A stepped-up test session requires an identity.");
    await db.query(`
      insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
      values ($1, $1, 'totp', 'verified', now(), now()) on conflict (id) do nothing
    `, [sub]);
    await db.query("select public.activate_staff_authenticator($1, $1)", [sub]);
    await db.query(`
      insert into auth.sessions (id, user_id, factor_id, aal, created_at, updated_at)
      values ($1, $1, $1, 'aal2', now(), now()) on conflict (id) do nothing
    `, [sub]);
  }
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, sub, ...(steppedUp && {
    session_id: sub, aal: "aal2", amr: [{ method: "password" }, { method: "totp" }],
  }) })]);
}
