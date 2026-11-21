import type { MetadataRoute } from "next";
import { indexableSiteOrigin } from "@/lib/catalogue/indexable-site";

export default function robots(): MetadataRoute.Robots {
  const origin = indexableSiteOrigin();
  if (!origin) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/account", "/api/", "/auth/", "/checkout"] },
    sitemap: `${origin}/sitemap.xml`,
  };
}
