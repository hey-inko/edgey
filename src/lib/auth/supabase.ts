import "server-only";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/database.types";

export const authCookieName = "edgey-auth";

export function createAuthClient(cookies: CookieMethodsServer) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase Auth configuration is missing.");
  return createServerClient<Database>(url, key, {
    cookies,
    cookieOptions: {
      name: authCookieName,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NEXT_PUBLIC_SITE_URL?.startsWith("https://") ?? false,
      path: "/",
    },
  });
}

export function storefrontUrl(path: string): URL {
  const origin = process.env.NEXT_PUBLIC_SITE_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3000" : undefined);
  if (!origin) throw new Error("The storefront origin is not configured.");
  return new URL(path, origin);
}
