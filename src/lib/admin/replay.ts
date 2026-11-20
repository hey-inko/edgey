import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { serviceClient } from "@/lib/supabase/service";

export type FinanceReplayTarget = { kind: "event" | "confirmation"; id: string };
type ReplayOutcome = "processed" | "failed" | "sent" | "pending" | "not_replayable";

export async function listFinanceRetryRequests(db: SupabaseClient<Database>, ids: string[]) {
  const chunks = Array.from({ length: Math.ceil(ids.length / 20) }, (_, i) => ids.slice(i * 20, (i + 1) * 20));
  return (await Promise.all(chunks.map(async (chunk) => {
    const { data, error } = await db.from("finance_retry_requests")
      .select("kind,target_id,target_updated_at,result").in("target_id", chunk);
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

export async function drainFinanceRetries(
  kind: FinanceReplayTarget["kind"],
  replay: (id: string, expectedVersion: string) => Promise<ReplayOutcome>,
) {
  const db = serviceClient();
  const { data, error } = await db.rpc("claim_finance_retries", { p_kind: kind });
  if (error) throw error;
  const settled = await Promise.allSettled(data.map(async (claim) => {
    if (!claim.worker_token) throw new Error("Finance replay was not leased.");
    const result = await replay(claim.target_id, claim.target_updated_at);
    const { error: finishError } = await db.rpc("finish_finance_retry", {
      p_kind: kind, p_target_id: claim.target_id, p_worker_token: claim.worker_token, p_result: result,
    });
    if (finishError) throw finishError;
    return result;
  }));
  return {
    claimed: settled.length,
    retryLater: settled.filter((item) => item.status === "rejected").length,
  };
}
