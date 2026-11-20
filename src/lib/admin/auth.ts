import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { getVerifiedBuyer, sessionClient } from "@/lib/auth/server";
import type { Database } from "@/lib/supabase/database.types";

export type StaffRole = Database["public"]["Enums"]["staff_role"];

export const staffSession = cache(async () => {
  const user = await getVerifiedBuyer();
  if (!user) return null;
  const db = await sessionClient();
  const { data, error } = await db.from("staff_members").select("role").eq("user_id", user.id);
  if (error) throw new Error("Could not verify access to the staff desk.");
  return data.length ? { db, userId: user.id, roles: data.map(({ role }) => role) } : null;
});

export async function requireStaff(role?: StaffRole) {
  const staff = await staffSession();
  if (!staff) redirect("/admin/sign-in");
  if (role && !staff.roles.includes(role)) redirect("/admin");
  return staff;
}
