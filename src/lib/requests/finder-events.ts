import "server-only";
import { headers } from "next/headers";
import { after } from "next/server";
import type { CatalogueView, SearchHit } from "@/lib/catalogue";
import { serviceClient } from "@/lib/supabase/service";
import { finderCodeForFingerprint, normaliseFinderCode, normaliseFinderWords, privateFinderQuery } from "./finder-query";
import { allowFinderEvent, requestFingerprint } from "./rate-limit";

export async function recordFinderSearch(query: string, hits: SearchHit[], view: CatalogueView) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.EDGEY_REQUEST_HASH_KEY) return;
  const requestHeaders = await headers();
  if (requestHeaders.has("next-router-prefetch") || requestHeaders.has("next-router-segment-prefetch")
    || requestHeaders.get("purpose") === "prefetch" || requestHeaders.get("sec-purpose")?.includes("prefetch")
    || /bot\b|crawler|spider/i.test(requestHeaders.get("user-agent") ?? "")) return;

  const visible = view.cards.find((card) => card.match === "exact") ?? view.cards[0];
  const exact = hits.find((hit) => hit.matchType === "exact");
  const outcome = visible?.match ?? "unmatched";
  const matchedCode = exact?.matchedCode && normaliseFinderCode(exact.matchedCode);
  const labels = [...view.machines, ...view.materials, ...view.toolTypes];
  const words = normaliseFinderWords(query);
  const publicLabel = labels.flatMap(({ name, slug }) => [normaliseFinderWords(name), normaliseFinderWords(slug)])
    .find((label) => label === words);
  const normalisedQuery = matchedCode || (!privateFinderQuery(query) ? publicLabel : undefined);
  const fingerprintInput = normalisedQuery ? undefined : finderCodeForFingerprint(query);

  after(async () => {
    try {
      if (!await allowFinderEvent()) return;
      const { error } = await serviceClient().rpc("record_finder_search", {
        p_outcome: outcome,
        p_normalised_query: normalisedQuery,
        p_query_fingerprint: fingerprintInput && process.env.EDGEY_REQUEST_HASH_KEY
          ? requestFingerprint("search", fingerprintInput)
          : undefined,
      });
      if (error) console.error("Finder event could not be recorded.");
    } catch {
      console.error("Finder event could not be recorded.");
    }
  });
}
