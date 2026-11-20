"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { focusCatalogueSearch } from "./search-shortcut";

// Clears every filter and puts focus back in search.
export function ClearFiltersLink({ className, children }: { className?: string; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <Link
      className={className}
      href={pathname + "#catalogue"}
      onClick={(event) => {
        event.preventDefault();
        router.replace(pathname, { scroll: false });
        focusCatalogueSearch();
      }}
    >
      {children}
    </Link>
  );
}

// A material row clears search and tool type, filters to the substrate,
// returns to the catalogue and focuses search.
export function MaterialLink({ slug, children }: { slug: string; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const href = pathname + "?material=" + slug;
  return (
    <Link
      href={href + "#catalogue"}
      onClick={(event) => {
        event.preventDefault();
        router.push(href, { scroll: false });
        focusCatalogueSearch();
      }}
    >
      {children}
    </Link>
  );
}
