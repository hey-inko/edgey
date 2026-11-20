"use client";

import { useActionState, useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { initialRequestFormState, requestTrapField, type RequestFormState } from "@/lib/requests/forms";
import styles from "./request.module.css";

export type RequestField = {
  name: string;
  label: string;
  initialValue?: string;
  required?: boolean;
  help?: string;
  maxLength?: number;
  autoComplete?: string;
} & (
  | { type?: "text" | "email" | "textarea" }
  | { type: "select"; options: readonly (readonly [string, string])[] }
);

export function RequestForm({
  action,
  fields,
  attemptId,
  submitLabel,
  successTitle,
  successMessage,
  keepFormOnSuccess = false,
}: {
  action: (previous: RequestFormState, data: FormData) => Promise<RequestFormState>;
  fields: RequestField[];
  attemptId?: string;
  submitLabel: string;
  successTitle: string;
  successMessage: string;
  keepFormOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, initialRequestFormState);
  const [attempt] = useState(attemptId);
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((field) => [field.name, field.initialValue ?? ""])));
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const hasError = state.status === "error";
  const succeeded = state.status === "success";
  const invalidFields = fields.filter((field) => state.errors?.[field.name]);

  useEffect(() => {
    if (state.status !== "idle") heading.current?.focus();
  }, [state]);

  return (
    <>
      {hasError && (
        <div className={styles.notice}>
          <h2 tabIndex={-1} ref={heading}>
            {invalidFields.length ? "Check the form" : "We couldn’t send the form"}
          </h2>
          {state.message && <p>{state.message}</p>}
          {!state.message && !invalidFields.length && <p>Please try again.</p>}
          {invalidFields.length > 0 && (
            <ul>
              {invalidFields.map((field) => (
                <li key={field.name}>
                  <a href={`#${id}-${field.name}`} className="textlink">
                    {state.errors?.[field.name]}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div role="status" aria-live="polite" aria-atomic="true">
        {succeeded && (
          <div className={styles.notice}>
            <h2 tabIndex={-1} ref={heading}>{successTitle}</h2>
            <p>{state.message ?? successMessage}</p>
          </div>
        )}
      </div>
      {(!succeeded || keepFormOnSuccess) && (
        <form action={formAction} noValidate className={styles.form}>
          {attempt && <input type="hidden" name="attemptId" value={attempt} />}
          <input name={requestTrapField} type="text" className={styles.trap} aria-hidden="true" tabIndex={-1} autoComplete="off" />
          {fields.map((field) => {
            const fieldId = `${id}-${field.name}`;
            const error = hasError ? state.errors?.[field.name] : undefined;
            const description = [
              field.help ? `${fieldId}-help` : null,
              error ? `${fieldId}-error` : null,
            ].filter(Boolean).join(" ");
            const inputProps = {
              id: fieldId,
              name: field.name,
              required: field.required,
              value: values[field.name],
              onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
                const value = event.currentTarget.value;
                setValues((current) => ({ ...current, [field.name]: value }));
              },
              "aria-describedby": description || undefined,
              "aria-invalid": error ? true : undefined,
            };

            return (
              <div key={field.name} className={styles.field}>
                <label htmlFor={fieldId}>{field.label}</label>
                {field.help && <p className="muted" id={`${fieldId}-help`}>{field.help}</p>}
                {field.type === "select" ? (
                  <div className="select-field">
                    <select {...inputProps}>
                      <option value="">{field.required ? "Choose an option" : "Not specified"}</option>
                      {field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </div>
                ) : field.type === "textarea" ? (
                  <textarea {...inputProps} rows={4} maxLength={field.maxLength} className={styles.control} />
                ) : (
                  <input
                    {...inputProps}
                    type={field.type ?? "text"}
                    maxLength={field.maxLength}
                    autoComplete={field.autoComplete}
                    className={styles.control}
                  />
                )}
                {error && <p id={`${fieldId}-error`} className={styles.fieldError}>{error}</p>}
              </div>
            );
          })}
          <button className={`primary ${styles.submit}`} type="submit" disabled={pending}>
            {pending ? "Sending…" : submitLabel}
          </button>
        </form>
      )}
    </>
  );
}
