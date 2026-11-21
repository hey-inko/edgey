import "server-only";
import manifest from "../../../docs/artwork-sources.json";
import type { Database } from "@/lib/supabase/database.types";
import type { Media } from "./index";

const designPack = new Map<string, Media>([
  ["EDG-Z10", { drawing: "drag-line.svg", photo: "drag.webp" }],
  ["EDG-Z16", { drawing: "oscillating-line.svg", photo: "oscillating.webp" }],
  ["EDG-Z50", { drawing: "rotary-line.svg", photo: "rotary.webp" }],
  ["EDG-SR6223", { drawing: "cylinder-line.svg", photo: "cylinder.webp" }],
]);
const proofs = new Set(["prism", "coral", "cyan", "lime", "violet"]);
const stagingOrigin = "https://staging.edgey.site";

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

type Artwork = { drawing?: string; photo?: string; proof?: string; rights: "rights not cleared" | "missing" | "cleared" };
type PublicationStatus = Database["public"]["Enums"]["publication_status"];
const artwork = new Map<string, Artwork | undefined>();

for (const value of manifest as unknown[]) {
  const row = record(value);
  if (typeof row?.sku !== "string" || !/^EDG-[A-Z0-9-]+$/.test(row.sku) || designPack.has(row.sku)) continue;
  const { sku, drawing, photo, rights } = row;
  if (artwork.has(sku) || (rights !== "rights not cleared" && rights !== "missing" && rights !== "cleared")) {
    artwork.set(sku, undefined);
    continue;
  }
  const drawingName = typeof drawing === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.svg$/.test(drawing) ? drawing : undefined;
  const photoName = photo === sku.toLowerCase() + ".webp" ? photo : undefined;
  const proof = typeof row.proof === "string" && proofs.has(row.proof) ? row.proof : undefined;
  artwork.set(sku, { drawing: drawingName, photo: photoName, proof, rights });
}

const restrictedPhotos = new Map([...artwork].flatMap(([sku, entry]) =>
  entry?.rights === "rights not cleared" && entry.photo ? [[entry.photo, sku] as const] : [],
));

function stagingPhotoSet() {
  const set = process.env.EDGEY_STAGING_PHOTO_SET;
  if (!set || !/^[a-f0-9]{32}$/.test(set)) return;
  const site = URL.parse(process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? "");
  if (site?.href === stagingOrigin + "/" && process.env.VERCEL === "1" &&
    process.env.VERCEL_ENV === "production" && process.env.EDGEY_INDEXING_ENABLED !== "true") return set;
}

export function stagingPhotoObject(name: string, request: Request) {
  const origin = request.headers.get("Origin");
  const set = stagingPhotoSet();
  const sku = restrictedPhotos.get(name);
  if (set && sku && URL.parse(request.url)?.origin === stagingOrigin &&
    (origin === null || origin === stagingOrigin)) return { sku, path: set + "/" + name };
}

function manifestPhoto(entry: Artwork, publicationStatus: PublicationStatus) {
  if (!entry.photo) return;
  if (entry.rights === "cleared") return entry.photo;
  if (entry.rights === "rights not cleared" && publicationStatus === "draft" && stagingPhotoSet()) return "staging/" + entry.photo;
}

export function resolveCatalogueMedia(value: unknown, familyCode: string, sku: string, publicationStatus: PublicationStatus = "published"): Media {
  const row = record(value);
  if (!row) return {};
  const single = familyCode === sku && !Object.hasOwn(row, "artwork") ? row : undefined;
  const pack = designPack.get(sku);
  const entry = artwork.get(sku);
  const legacy = Object.keys(row).length === 0;
  const proof = legacy ? entry?.proof : typeof row.proof === "string" && proofs.has(row.proof) ? row.proof : undefined;
  const fromManifest = legacy || row.artwork === "by-sku";
  const drawing = pack
    ? single?.drawing === pack.drawing ? pack.drawing : undefined
    : entry && (fromManifest || single?.drawing === entry.drawing) ? entry.drawing : undefined;
  const photo = pack
    ? single?.photo === pack.photo ? pack.photo : undefined
    : entry && (fromManifest || single?.photo === entry.photo) ? manifestPhoto(entry, publicationStatus) : undefined;
  return { ...(drawing && { drawing }), ...(photo && { photo }), ...(proof && { proof }) };
}

export function resolveQuotePhoto(sku: string, photo: unknown) {
  const pack = designPack.get(sku);
  if (pack) return photo === pack.photo ? pack.photo : undefined;
  const entry = artwork.get(sku);
  if (entry?.rights === "cleared" && (photo === null || photo === undefined || photo === entry.photo)) return entry.photo;
}
