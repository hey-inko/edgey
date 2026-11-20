import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminLink } from "./ui";
import { staffSession } from "@/lib/admin/auth";
import { signOutStaff } from "./session-actions";
import "./admin.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Staff admin",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const staff = await staffSession();
  const roles = staff?.roles ?? [];

  return (
    <main className="admin frame" id="main-content">
      {staff && (
        <div className="admin-bar">
          <nav aria-label="Staff areas">
            <AdminLink href="/admin">Staff desk</AdminLink>
            {roles.includes("warehouse") && <><AdminLink href="/admin/warehouse">Pick and dispatch</AdminLink><AdminLink href="/admin/stock">Stock</AdminLink></>}
            {roles.includes("catalogue") && <AdminLink href="/admin/catalogue">Catalogue</AdminLink>}
            {roles.includes("finance") && <AdminLink href="/admin/finance">Finance</AdminLink>}
            <AdminLink href="/admin/requests">Requests</AdminLink>
          </nav>
          <form action={signOutStaff}><button className="admin-secondary">Sign out</button></form>
        </div>
      )}
      {children}
    </main>
  );
}
