"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { focusCatalogueSearch } from "./search-shortcut";

function resetControlsAndFocus() {
  const form = document.getElementById("catalogue-controls");
  if (form instanceof HTMLFormElement) form.reset();
  focusCatalogueSearch();
}

// Clears every filter and puts focus back in search.
export function ClearFiltersLink({ className, children }: { className?: string; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <Link
      className={className}
      href={pathname + "#catalogue"}
      replace
      scroll={false}
      onNavigate={resetControlsAndFocus}
    >
      {children}
    </Link>
  );
}

// A material row clears search and tool type, filters to the substrate,
// returns to the catalogue and focuses search.
export function MaterialLink({ slug, children }: { slug: string; children: ReactNode }) {
  const pathname = usePathname();
  const href = pathname + "?material=" + slug;
  return (
    <Link
      href={href + "#catalogue"}
      scroll={false}
      onNavigate={resetControlsAndFocus}
    >
      {children}
    </Link>
  );
}
