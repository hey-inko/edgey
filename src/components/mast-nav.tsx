"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// "Blade catalogue" scrolls on the home page and opens /blades elsewhere.
export function MastNav() {
  const pathname = usePathname();
  const onHome = pathname === "/";
  const hasMaterials = onHome || pathname === "/blades";
  return (
    <nav aria-label="Main navigation">
      <Link href={onHome ? "/#catalogue" : "/blades"}>
        <span className="nav-wide">Blade catalogue</span>
        <span className="nav-short">Blades</span>
      </Link>
      <Link href={hasMaterials ? pathname + "#materials" : "/blades#materials"}>Materials</Link>
    </nav>
  );
}
