import { redirect } from "next/navigation";
import { staffSession } from "@/lib/admin/auth";
import { signInStaff } from "../session-actions";
import { AdminField, AdminForm, AdminHeading } from "../ui";

export const metadata = { title: "Staff sign-in" };

export default async function StaffSignIn() {
  if (await staffSession()) redirect("/admin");
  return (
    <>
      <AdminHeading title="Staff sign-in" description="Use the account issued to you for Edgey operations." />
      <div className="admin-panel admin-narrow">
        <AdminForm action={signInStaff} submit="Sign in">
          <AdminField label="Work email"><input type="email" name="email" autoComplete="username" maxLength={254} required /></AdminField>
          <AdminField label="Password"><input type="password" name="password" autoComplete="current-password" maxLength={128} required /></AdminField>
        </AdminForm>
      </div>
    </>
  );
}
