"use server";

import { createClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { staffIdentity } from "@/lib/admin/auth";
import { sessionClient } from "@/lib/auth/server";
import { allowRequest } from "@/lib/requests/rate-limit";
import type { Database } from "@/lib/supabase/database.types";
import type { AdminResult } from "./form";

export async function signInStaff(_: AdminResult | null, form: FormData): Promise<AdminResult> {
  const email = form.get("email");
  const password = form.get("password");
  const invalid = { ok: false, message: "Could not sign in. Check your staff email and password." };
  if (typeof email !== "string" || email.length > 254 || !email.trim() ||
    typeof password !== "string" || !password || password.length > 128) return invalid;
  try {
    if (!await allowRequest("staff_sign_in", email.trim())) {
      return { ok: false, message: "Too many sign-in attempts. Try again later." };
    }
  } catch {
    return { ok: false, message: "Staff sign-in is unavailable. Try again later." };
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return { ok: false, message: "Staff sign-in is unavailable. Try again later." };
  const login = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: { user, session }, error } = await login.auth.signInWithPassword({ email: email.trim(), password });
  if (error || !session || !user?.email_confirmed_at || user.is_anonymous) return invalid;
  const membership = await login.from("staff_members").select("role").eq("user_id", user.id).limit(1);
  if (membership.error || !membership.data.length) {
    await login.auth.signOut({ scope: "local" });
    return invalid;
  }

  const client = await sessionClient();
  const saved = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (saved.error) return invalid;
  redirect("/admin/sign-in");
}

const mfaUnavailable = { ok: false, message: "Authenticator verification is unavailable. Try again later." };

async function mfaIdentity() {
  const staff = await staffIdentity();
  if (!staff || staff.sessionFactor) return null;
  try {
    return await allowRequest("staff_mfa", staff.email) ? staff : null;
  } catch {
    return null;
  }
}

export async function enrollStaffAuthenticator(): Promise<AdminResult & { setupKey?: string; factorId?: string }> {
  const staff = await mfaIdentity();
  if (!staff || staff.approvedFactor) return mfaUnavailable;
  const { data: factors, error } = await staff.db.auth.mfa.listFactors();
  if (error || factors.totp.length) return mfaUnavailable;
  for (const factor of factors.all) {
    if (factor.factor_type === "totp" && factor.status === "unverified") {
      if ((await staff.db.auth.mfa.unenroll({ factorId: factor.id })).error) return mfaUnavailable;
    }
  }
  const enrolled = await staff.db.auth.mfa.enroll({ factorType: "totp", issuer: "Edgey", friendlyName: "Edgey staff" });
  if (enrolled.error) return mfaUnavailable;
  return { ok: true, message: "Add the setup key to your authenticator.", setupKey: enrolled.data.totp.secret, factorId: enrolled.data.id };
}

export async function verifyStaffAuthenticator(_: AdminResult | null, form: FormData): Promise<AdminResult> {
  const factorId = form.get("factorId");
  const code = form.get("code");
  if (typeof factorId !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(factorId) ||
      typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return { ok: false, message: "Enter the six-digit code from your authenticator." };
  }
  const staff = await mfaIdentity();
  if (!staff || (staff.approvedFactor && factorId !== staff.approvedFactor)) return mfaUnavailable;
  const { error } = await staff.db.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) return { ok: false, message: "Could not verify the code. Try again with a fresh code." };
  redirect(staff.approvedFactor ? "/admin" : "/admin/sign-in");
}

export async function signOutStaff() {
  const db = await sessionClient();
  await db.auth.signOut({ scope: "local" });
  redirect("/admin/sign-in");
}
