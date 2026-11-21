import type { MetadataRoute } from "next";
import { indexableSiteOrigin } from "@/lib/catalogue/indexable-site";
import { publicClient } from "@/lib/catalogue/supabase";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = indexableSiteOrigin();
  if (!origin) return [];
  const { data, error } = await publicClient().from("products").select("slug").order("slug");
  if (error) throw new Error("Published sitemap could not be loaded.");
  return ["/", "/blades", ...data.map(({ slug }) => `/blades/${slug}`)].map((path) => ({ url: origin + path }));
}
