import "server-only";

export function indexableSiteOrigin() {
  if (process.env.EDGEY_INDEXING_ENABLED !== "true") return;
  const url = URL.parse(process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? "");
  if (!url || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return;
  if (url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return url.origin;
}
