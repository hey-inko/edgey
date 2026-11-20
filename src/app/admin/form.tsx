"use client";

import { useActionState, type ReactNode } from "react";

export type AdminResult = { message: string; ok: boolean };

export function AdminForm({ action, children, submit }: {
  action: (previous: AdminResult | null, data: FormData) => Promise<AdminResult>;
  children?: ReactNode;
  submit: string;
}) {
  const [result, submitAction, pending] = useActionState(action, null);
  return (
    <form className="admin-form" action={submitAction} aria-busy={pending}>
      {children}
      <div><button className="primary" disabled={pending}>{pending ? "Saving…" : submit}</button></div>
      {result && (
        <p className="admin-notice" role={result.ok ? "status" : "alert"}>{result.message}</p>
      )}
    </form>
  );
}
