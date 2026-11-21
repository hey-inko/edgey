import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/photos/staging/[name]/route";
import { resolveCatalogueMedia } from "@/lib/catalogue/media";
import { getFamily } from "@/lib/catalogue/server";
import { quoteSelectionWith } from "@/lib/checkout/quote";

const { staffSession, variantFrom, variantEq, variantRead, storageFrom, download } = vi.hoisted(() => {
  const variantRead = vi.fn();
  const variantEq = vi.fn(() => ({ maybeSingle: variantRead }));
  const variantFrom = vi.fn(() => ({ select: () => ({ eq: variantEq }) }));
  const download = vi.fn();
  return { staffSession: vi.fn(), variantFrom, variantEq, variantRead, storageFrom: vi.fn(() => ({ download })), download };
});
vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({ from: variantFrom, storage: { from: storageFrom } }),
}));
vi.mock("@/lib/admin/auth", () => ({ staffSession }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/requests/finder-events", () => ({}));
vi.mock("../../docs/artwork-sources.json", () => ({
  default: [
    { sku: "EDG-FAMILY-A", drawing: "edg-family-a-line.svg", photo: "edg-family-a.webp", rights: "rights not cleared" },
    { sku: "EDG-FAMILY-B", drawing: "edg-family-b-line.svg", photo: "edg-family-b.webp", rights: "cleared" },
    { sku: "EDG-FAMILY-DRAFT", drawing: "edg-family-draft-line.svg", photo: "edg-family-draft.webp", rights: "rights not cleared" },
    { sku: "EDG-FAMILY-MISSING", drawing: "edg-family-missing-line.svg", photo: null, rights: "missing" },
    { sku: "EDG-INVALID", drawing: "../private.svg", photo: "edg-family-a.webp", rights: "cleared" },
  ],
}));

const stagingOrigin = "https://staging.edgey.site";
const liveOrigin = "https://edgey.site";
const restrictedPhoto = "edg-family-a.webp";
const clearedPhoto = "edg-family-b.webp";
const restrictedDrawing = "edg-family-a-line.svg";
const clearedDrawing = "edg-family-b-line.svg";
const photoSet = "aabbccddeeff00112233445566778899";

function deployment(origin: string | undefined, environment = "production", indexing = "false", vercel = "1") {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("VERCEL", vercel);
  vi.stubEnv("VERCEL_ENV", environment);
  vi.stubEnv("EDGEY_INDEXING_ENABLED", indexing);
  vi.stubEnv("EDGEY_STAGING_PHOTO_SET", photoSet);
}

function fetchPhoto(name: string, origin: string, headers?: HeadersInit) {
  return GET(new Request(`${origin}/photos/staging/${encodeURIComponent(name)}`, { headers }),
    { params: Promise.resolve({ name }) });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  storageFrom.mockClear();
  download.mockReset();
  staffSession.mockReset();
  variantFrom.mockClear();
  variantEq.mockClear();
  variantRead.mockReset();
});

describe("catalogue media", () => {
  it("uses exact SKU fallback only for empty media or an explicitly per-SKU family", () => {
    deployment(stagingOrigin);
    const expected = { drawing: restrictedDrawing };
    expect(resolveCatalogueMedia({}, "EDG-FAMILY", "EDG-FAMILY-A")).toEqual(expected);
    expect(resolveCatalogueMedia({ drawing: restrictedDrawing, photo: restrictedPhoto }, "EDG-FAMILY-A", "EDG-FAMILY-A")).toEqual(expected);
    expect(resolveCatalogueMedia({ artwork: "by-sku", proof: "lime" }, "EDG-FAMILY", "EDG-FAMILY-A")).toEqual({ ...expected, proof: "lime" });
    expect(resolveCatalogueMedia({ proof: "lime" }, "EDG-FAMILY", "EDG-FAMILY-A")).toEqual({ proof: "lime" });
    expect(resolveCatalogueMedia(null, "EDG-FAMILY", "EDG-FAMILY-A")).toEqual({});
    expect(resolveCatalogueMedia({}, "EDG-FAMILY", "edg-family-a")).toEqual({});
    expect(resolveCatalogueMedia({}, "EDG-FAMILY", "EDG-FAMILY-MISSING")).toEqual({ drawing: "edg-family-missing-line.svg" });
    expect(resolveCatalogueMedia({}, "EDG-INVALID", "EDG-INVALID")).toEqual({});
  });

  it("gives only drafts an uncleared photo reference on opted-in staging without disclosing storage paths", () => {
    deployment(stagingOrigin);
    expect(resolveCatalogueMedia({}, "EDG-FAMILY", "EDG-FAMILY-A", "draft")).toEqual({
      drawing: restrictedDrawing, photo: "staging/" + restrictedPhoto,
    });
    expect(resolveCatalogueMedia({}, "EDG-FAMILY", "EDG-FAMILY-A", "archived")).toEqual({ drawing: restrictedDrawing });
    expect(resolveCatalogueMedia({}, "EDG-FAMILY", "EDG-FAMILY-A", "published")).toEqual({ drawing: restrictedDrawing });
  });

  it("preserves the design pack and rejects wrong, cross-SKU and path-shaped references", () => {
    deployment(liveOrigin);
    expect(resolveCatalogueMedia({ drawing: "drag-line.svg", photo: "drag.webp", proof: "coral" }, "EDG-Z10", "EDG-Z10"))
      .toEqual({ drawing: "drag-line.svg", photo: "drag.webp", proof: "coral" });
    expect(resolveCatalogueMedia({ drawing: restrictedDrawing, photo: "staging/" + restrictedPhoto }, "EDG-FAMILY-A", "EDG-FAMILY-A"))
      .toEqual({ drawing: restrictedDrawing });
    expect(resolveCatalogueMedia({ drawing: restrictedDrawing, photo: restrictedPhoto }, "EDG-FAMILY-B", "EDG-FAMILY-B"))
      .toEqual({});
    expect(resolveCatalogueMedia({ drawing: "../" + clearedDrawing, photo: "../" + clearedPhoto }, "EDG-FAMILY-B", "EDG-FAMILY-B"))
      .toEqual({});
  });

  it.each([liveOrigin, stagingOrigin])("uses the first published visible variant as the family default on %s", async (origin) => {
    deployment(origin);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.example.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-foo");
    const fetch = vi.fn(async (input: URL) => {
      const url = new URL(input);
      expect(url.searchParams.get("variants.publication_status")).toBe("eq.published");
      expect(url.searchParams.get("slug")).toBe("eq.edg-family");
      return Response.json([{
        family_code: "EDG-FAMILY", slug: "edg-family", media: { artwork: "by-sku", proof: "prism" },
        tool_categories: { slug: "drag", name: "Drag", sort_order: 1 },
        variants: [
          { sku: "EDG-FAMILY-B", sort_order: 30, variant_substrates: [], compatibility: [] },
          { sku: "EDG-FAMILY-A", sort_order: 20, variant_substrates: [], compatibility: [] },
        ],
      }]);
    });
    vi.stubGlobal("fetch", fetch);
    const family = await getFamily("edg-family");
    expect(fetch).toHaveBeenCalledOnce();
    expect(family?.variants.map(({ sku, media }) => ({ sku, media }))).toEqual([
      { sku: "EDG-FAMILY-A", media: { drawing: restrictedDrawing, proof: "prism" } },
      { sku: "EDG-FAMILY-B", media: { drawing: clearedDrawing, photo: clearedPhoto, proof: "prism" } },
    ]);
    expect(family?.media).toEqual({ drawing: restrictedDrawing, proof: "prism" });
    expect(JSON.stringify(family)).not.toMatch(/edg-family-a\.webp|DRAFT|edg-family-draft/);
  });
});

describe("checkout media", () => {
  it.each([liveOrigin, stagingOrigin])("quotes each visible SKU with its allowed photo on %s", async (origin) => {
    deployment(origin);
    const ids = [
      "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-cccc-cccccccccccc",
      "dddddddd-dddd-4ddd-dddd-dddddddddddd",
      "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee",
    ] as const;
    const variants = [
      { id: ids[0], sku: "EDG-FAMILY-A", photo: null },
      { id: ids[1], sku: "EDG-FAMILY-B", photo: null },
      { id: ids[2], sku: "EDG-OTHER", photo: clearedPhoto },
      { id: ids[3], sku: "EDG-Z10", photo: "oscillating.webp" },
    ].map((variant) => ({
      ...variant, optionLabel: null, availableQuantity: 10, tierPrices: { oneToFour: 500, fiveToNine: 400, tenPlus: 300 },
    }));
    const result = await quoteSelectionWith(ids.map((variantId) => ({ variantId, quantity: 1 })), undefined, {
      lookup: async () => variants,
      readWarehouseSchedule: async () => null,
      resolveDelivery: async () => { throw new Error("No postcode was requested"); },
      now: () => new Date("2026-11-21"),
    });
    expect(result).toMatchObject({
      status: "ok",
      lines: ids.slice(0, 4).map((variantId) => ({ variantId, quantity: 1 })),
      photos: { [ids[1]]: clearedPhoto },
    });
    if (result.status !== "ok") throw new Error(result.message);
    expect(result.photos).toEqual({ [ids[1]]: clearedPhoto });
  });
});

describe("staging photo route", () => {
  it.each([
    [liveOrigin, "production", "false", "1"],
    [stagingOrigin, "preview", "false", "1"],
    [stagingOrigin, "production", "true", "1"],
    [stagingOrigin, "production", "false", "0"],
    ["http://localhost:3000", "development", "false", "0"],
    [undefined, "production", "false", "1"],
  ])("does not expose restricted references or bytes with configuration %j/%s/%s/%s", async (origin, environment, indexing, vercel) => {
    deployment(origin, environment, indexing, vercel);
    expect(resolveCatalogueMedia({}, "EDG-FAMILY", "EDG-FAMILY-A", "draft")).toEqual({ drawing: restrictedDrawing });
    const response = await fetchPhoto(restrictedPhoto, stagingOrigin, { "X-Forwarded-Host": "staging.edgey.site", Host: "staging.edgey.site", Origin: stagingOrigin });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(staffSession).not.toHaveBeenCalled();
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("serves only a restricted allowlisted basename on the canonical staging origin, without caching", async () => {
    deployment(stagingOrigin);
    staffSession.mockResolvedValue({ roles: ["catalogue"] });
    variantRead.mockResolvedValue({ data: { publication_status: "draft" }, error: null });
    download.mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    const alias = await fetchPhoto(restrictedPhoto, "https://edgey-staging.vercel.app", { "X-Forwarded-Host": "staging.edgey.site", Origin: stagingOrigin });
    expect(alias.status).toBe(404);
    expect((await fetchPhoto(restrictedPhoto, stagingOrigin, { Origin: liveOrigin })).status).toBe(404);
    for (const name of [clearedPhoto, "drag.webp", "edg-unknown.webp", "../" + restrictedPhoto]) {
      expect((await fetchPhoto(name, stagingOrigin)).status).toBe(404);
    }
    expect(staffSession).not.toHaveBeenCalled();
    expect(storageFrom).not.toHaveBeenCalled();
    const response = await fetchPhoto(restrictedPhoto, stagingOrigin);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(variantFrom).toHaveBeenCalledExactlyOnceWith("variants");
    expect(variantEq).toHaveBeenCalledExactlyOnceWith("sku", "EDG-FAMILY-A");
    expect(storageFrom).toHaveBeenCalledExactlyOnceWith("catalogue-review-photos");
    expect(download).toHaveBeenCalledExactlyOnceWith(photoSet + "/" + restrictedPhoto);
  });

  it.each([undefined, "", "not-a-photo-set", "A".repeat(32)])("defaults to off with photo set %j", async (set) => {
    deployment(stagingOrigin);
    vi.stubEnv("EDGEY_STAGING_PHOTO_SET", set);
    expect(resolveCatalogueMedia({}, "EDG-FAMILY", "EDG-FAMILY-A", "draft")).toEqual({ drawing: restrictedDrawing });
    expect((await fetchPhoto(restrictedPhoto, stagingOrigin)).status).toBe(404);
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("does not query the variant or fetch storage without a verified catalogue staff session", async () => {
    deployment(stagingOrigin);
    staffSession.mockResolvedValueOnce(null).mockResolvedValueOnce({ roles: ["finance"] });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await fetchPhoto(restrictedPhoto, stagingOrigin)).status).toBe(404);
    }
    expect(variantFrom).not.toHaveBeenCalled();
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it.each(["published", "archived", null])("denies a stale preview when the SKU status is %j", async (status) => {
    deployment(stagingOrigin);
    staffSession.mockResolvedValue({ roles: ["catalogue"] });
    variantRead.mockResolvedValue({ data: status && { publication_status: status }, error: null });
    expect((await fetchPhoto(restrictedPhoto, stagingOrigin)).status).toBe(404);
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("treats private storage failures as a non-cacheable 404", async () => {
    deployment(stagingOrigin);
    staffSession.mockResolvedValue({ roles: ["catalogue"] });
    variantRead.mockResolvedValue({ data: { publication_status: "draft" }, error: null });
    download.mockResolvedValueOnce({ data: null, error: new Error("Storage object not found") });
    download.mockRejectedValueOnce(new Error("Storage backend unavailable"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchPhoto(restrictedPhoto, stagingOrigin);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).toBe("");
    }
  });
});
