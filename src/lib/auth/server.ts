import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { authCookieName, createAuthClient } from "./supabase";

export const sessionClient = cache(async () => {
  const jar = await cookies();
  return createAuthClient({
    getAll: () => jar.getAll(),
    setAll: (values) => {
      try {
        for (const { name, value, options } of values) jar.set(name, value, options);
      } catch {
      }
    },
  });
});

export const getVerifiedBuyer = cache(async () => {
  const jar = await cookies();
  if (!jar.getAll().some(({ name }) => name === authCookieName || name.startsWith(authCookieName + "."))) return null;
  const client = await sessionClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user?.email || !user.email_confirmed_at || user.is_anonymous) return null;
  return { id: user.id, email: user.email };
});

export async function getOwnTradeApplicationStatus() {
  const buyer = await getVerifiedBuyer();
  if (!buyer) return null;
  const { data, error } = await (await sessionClient()).from("trade_applications")
    .select("status").eq("buyer_id", buyer.id).maybeSingle();
  if (error) throw new Error("Trade application status is unavailable.");
  const status = data?.status;
  if (status === "pending" || status === "approved" || status === "rejected") return status;
  return null;
}
