import "server-only";
import { isIP } from "node:net";
import { headers } from "next/headers";
import { after } from "next/server";
import { queryValue, type CatalogueFilters, type CatalogueView, type SearchHit } from "@/lib/catalogue";
import { serviceClient } from "@/lib/supabase/service";
import { commercialDb } from "@/lib/commercial/database";
import { finderAttributionAllowed } from "@/lib/commercial/privacy";
import { finderCodeForFingerprint, normaliseFinderCode, normaliseFinderWords, privateFinderQuery } from "./finder-query";
import { allowFinderEvent, requestFingerprint } from "./rate-limit";

export async function recordFinderSearch(filters: CatalogueFilters, hits: SearchHit[], view: CatalogueView) {
  if (!process.env.EDGEY_REQUEST_HASH_KEY) return;
  const requestHeaders = await headers();
  if (requestHeaders.has("next-action") || requestHeaders.has("next-router-prefetch") || requestHeaders.has("next-router-segment-prefetch")
    || requestHeaders.get("purpose") === "prefetch" || requestHeaders.get("sec-purpose")?.includes("prefetch")
    || /bot\b|crawler|spider|edgeybenchmark/i.test(requestHeaders.get("user-agent") ?? "")) return;
  const referer = requestHeaders.get("sec-fetch-dest") !== "document" ? URL.parse(requestHeaders.get("referer") ?? "") : null;
  if (referer && (referer.pathname === "/" || referer.pathname === "/blades")
    && Object.entries(filters).every(([key, value]) => queryValue(referer.searchParams.get(key) ?? undefined) === value)) return;

  const query = filters.q.trim();
  const visible = view.cards.find((card) => card.match === "exact") ?? view.cards[0];
  const outcome = visible?.match ?? "unmatched";
  if (visible?.match === "exact") {
    const code = normaliseFinderCode(visible.matchedCode ?? "");
    const variants = view.cards.filter(({ match }) => match === "exact").flatMap((card) =>
      card.variants.filter((variant) => hits.some((hit) => hit.matchType === "exact" &&
        hit.sku === variant.sku && normaliseFinderCode(hit.matchedCode ?? "") === code)).map(({ id }) => id),
    );
    try {
      if (!await allowFinderEvent()) return;
      const { data, error } = await commercialDb().rpc("record_exact_finder_search", {
        p_code: code,
        p_variant_ids: isIP(query) || /@|:\/\/|\bwww\./i.test(query) ? [] : variants,
      });
      if (error) throw error;
      return data && await finderAttributionAllowed() ? data : undefined;
    } catch {
      console.error("Finder event could not be recorded.");
      return;
    }
  }
  const labels = [...view.machines, ...view.materials, ...view.toolTypes];
  const words = normaliseFinderWords(query);
  const publicLabel = labels.flatMap(({ name, slug }) => [normaliseFinderWords(name), normaliseFinderWords(slug)])
    .find((label) => label === words);
  const privateQuery = isIP(query) || privateFinderQuery(query);
  const normalisedQuery = privateQuery ? undefined : publicLabel;
  const fingerprintInput = normalisedQuery || privateQuery ? undefined : finderCodeForFingerprint(query);

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
