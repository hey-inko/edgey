import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Public, anonymous client. Row-level security decides what it can read, so the
// storefront can only ever render approved records of published variants.
export function publicClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. Run: pnpm db:start && pnpm db:env");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
