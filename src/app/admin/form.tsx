"use client";

import { createContext, useActionState, useContext, type ReactNode } from "react";

export type AdminResult = { message: string; ok: boolean; field?: string };
const ResultContext = createContext<AdminResult | null>(null);

export function useAdminFieldError(name: string) {
  const result = useContext(ResultContext);
  return !result?.ok && result?.field === name ? result.message : undefined;
}

export function AdminForm({ action, children, submit }: {
  action: (previous: AdminResult | null, data: FormData) => Promise<AdminResult>;
  children?: ReactNode;
  submit: string;
}) {
  const [result, submitAction, pending] = useActionState(action, null);
  return (
    <form className="admin-form" action={submitAction} aria-busy={pending}>
      <ResultContext.Provider value={result}>{children}</ResultContext.Provider>
      <div><button className="primary" disabled={pending}>{pending ? "Saving…" : submit}</button></div>
      {result && !result.field && (
        <p className="admin-notice" role={result.ok ? "status" : "alert"}>{result.message}</p>
      )}
    </form>
  );
}
