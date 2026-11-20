import { CatalogueSection } from "@/components/catalogue-section";
import { Hero } from "@/components/hero";
import { MaterialIndex } from "@/components/material-index";
import { readFilters, type RouteQuery } from "@/lib/catalogue";
import { loadCatalogue } from "@/lib/catalogue/server";

type Props = { searchParams: Promise<RouteQuery> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const filters = readFilters(await searchParams);
  return {
    alternates: { canonical: "/" },
    robots: Object.values(filters).some(Boolean) ? { index: false, follow: true } : undefined,
  };
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
import type { Metadata } from "next";
