import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { serviceClient } from "@/lib/supabase/service";

export type FinanceReplayTarget = { kind: "event" | "confirmation"; id: string };

export async function listFinanceRetryRequests(db: SupabaseClient<Database>, ids: string[]) {
  const chunks = Array.from({ length: Math.ceil(ids.length / 20) }, (_, i) => ids.slice(i * 20, (i + 1) * 20));
  return (await Promise.all(chunks.map(async (chunk) => {
    const { data, error } = await db.from("finance_retry_requests")
      .select("kind,target_id,target_updated_at").in("target_id", chunk);
    if (error) throw new Error("Could not read retry requests.");
    return data;
  }))).flat();
}

export async function requestFinanceReplay(actorId: string, target: FinanceReplayTarget) {
  const { data, error } = await serviceClient().rpc("request_finance_retry", {
    p_actor_id: actorId, p_kind: target.kind, p_target_id: target.id,
  });
  if (error) throw error;
  return data;
}
