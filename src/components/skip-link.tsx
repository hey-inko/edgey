"use client";

import { usePathname } from "next/navigation";

export function SkipLink() {
  const pathname = usePathname();
  const catalogue = pathname === "/" || pathname === "/blades";
  return <a className="skip" href={catalogue ? "#catalogue" : "#main-content"}>{catalogue ? "Skip to catalogue" : "Skip to main content"}</a>;
}
