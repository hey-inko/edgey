import type { Metadata } from "next";
import { CatalogueSection } from "@/components/catalogue-section";
import { Hero } from "@/components/hero";
import { MaterialIndex } from "@/components/material-index";
import { readFilters, type RouteQuery } from "@/lib/catalogue";
import { loadCatalogue } from "@/lib/catalogue/server";
import { siteUrl } from "@/lib/catalogue/site-url";

type Props = { searchParams: Promise<RouteQuery> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const filters = readFilters(await searchParams);
  return Object.values(filters).some(Boolean)
    ? { robots: { index: false, follow: true } }
    : { alternates: { canonical: siteUrl("/") } };
}

export default async function HomePage({ searchParams }: Props) {
  const filters = readFilters(await searchParams);
  const view = await loadCatalogue(filters);
  return (
    <main>
      <Hero />
      <CatalogueSection view={view} filters={filters} />
      <MaterialIndex materials={view.materials} />
    </main>
  );
}
