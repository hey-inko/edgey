"use client";

import { useId, useState } from "react";
import { useAdminFieldError } from "../form";

export function AddressInput({ label, name, initial = "", maxLength, required = false }: {
  label: string; name: string; initial?: string; maxLength: number; required?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const error = useAdminFieldError(name);
  const id = useId();
  return <div className="admin-field">
    <label htmlFor={id}>{label}</label>
    <input id={id} name={name} value={value} onChange={(event) => setValue(event.target.value)} maxLength={maxLength} required={required}
      aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} />
    {error && <span id={`${id}-error`} role="alert">{error}</span>}
  </div>;
}
