import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { getVerifiedBuyer, sessionClient } from "@/lib/auth/server";
import type { Database } from "@/lib/supabase/database.types";

export type StaffRole = Database["public"]["Enums"]["staff_role"];

export const staffIdentity = cache(async () => {
  const user = await getVerifiedBuyer();
  if (!user) return null;
  const db = await sessionClient();
  const { data: verified, error: claimsError } = await db.auth.getClaims();
  const claims = verified?.claims;
  if (claimsError || claims?.sub !== user.id ||
      !claims.amr?.some((entry) => typeof entry === "object" && entry.method === "password")) return null;
  const [membership, assurance] = await Promise.all([
    db.from("staff_members").select("role").eq("user_id", user.id),
    db.rpc("get_staff_authenticator").maybeSingle(),
  ]);
  if (membership.error || assurance.error) throw new Error("Could not verify access to the staff desk.");
  if (!membership.data.length || !assurance.data) return null;
  const { approved_factor_id: approvedFactor, session_factor_id: sessionFactor } = assurance.data;
  return {
    db, userId: user.id, email: user.email, roles: membership.data.map(({ role }) => role),
    approvedFactor, sessionFactor, steppedUp: approvedFactor !== null && approvedFactor === sessionFactor,
  };
});

export const staffSession = cache(async () => {
  const staff = await staffIdentity();
  return staff?.steppedUp ? staff : null;
});

export async function requireStaff(role?: StaffRole) {
  const staff = await staffSession();
  if (!staff) redirect("/admin/sign-in");
  if (role && !staff.roles.includes(role)) redirect("/admin");
  return staff;
}
