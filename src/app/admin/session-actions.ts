"use server";

import { createClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
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
  if (!url || !key) return { ok: false, message: "Staff sign-in is not configured." };
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
  redirect("/admin");
}

export async function signOutStaff() {
  const db = await sessionClient();
  await db.auth.signOut({ scope: "local" });
  redirect("/admin/sign-in");
}
