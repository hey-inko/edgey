"use client";

import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";
import { checkoutReview } from "@/app/checkout/actions";
import type { CheckoutFields } from "@/lib/checkout/types";
import { formatGbp, type LineRequest } from "@/lib/commerce";
import { useSelection } from "./selection-provider";
import { DispatchEstimate, SelectionLinePrice, SelectionTotals } from "./selection-summary";
import { useSelectionQuote } from "./use-selection-quote";

const initialFields: CheckoutFields = {
  businessName: "", email: "", buyingForWork: false,
  recipientName: "", line1: "", line2: "", town: "", region: "", postcode: "",
};

const fields = {
  businessName: { label: "Business name", autoComplete: "organization" },
  email: { label: "Contact email", autoComplete: "email", type: "email" },
  recipientName: { label: "Recipient name", autoComplete: "shipping name" },
  line1: { label: "Address line 1", autoComplete: "shipping address-line1" },
  line2: { label: "Address line 2 (optional)", autoComplete: "shipping address-line2", optional: true },
  town: { label: "Town or city", autoComplete: "shipping address-level2" },
  region: { label: "County (optional)", autoComplete: "shipping address-level1", optional: true },
  postcode: { label: "Postcode", autoComplete: "shipping postal-code" },
} satisfies Record<Exclude<keyof CheckoutFields, "buyingForWork">, {
  label: string; autoComplete: string; type?: string; optional?: boolean;
}>;

type FieldName = keyof typeof fields;
type SubmitResult = Awaited<ReturnType<typeof checkoutReview>>;

function materialValue(name: keyof CheckoutFields, value: string | boolean) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (name === "email") {
    const at = trimmed.lastIndexOf("@");
    return trimmed.slice(0, at + 1) + trimmed.slice(at + 1).toLowerCase();
  }
  if (name === "postcode") return trimmed.replace(/\s+/g, "").toUpperCase();
  return trimmed.normalize("NFC").replace(/\s+/g, " ");
}

export function CheckoutReview() {
  const { hydrated, lines, revision, replace, open } = useSelection();
  const id = useId();
  const [values, setValues] = useState(initialFields);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ lines: LineRequest[]; value: SubmitResult } | null>(null);
  const attempt = useRef<{ token: string; revision: number } | null>(null);
  const submitLock = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const summaryTitle = useRef<HTMLHeadingElement>(null);
  const postcode = values.postcode.trim();
  const { quote, pending, retry } = useSelectionQuote(lines, hydrated && lines.length > 0, postcode || undefined);
  const response = result?.lines === lines ? result.value : undefined;
  const shown = response?.status === "review" ? response.quote : quote;
  const priced = shown?.status === "ok" ? shown : null;
  const basket = priced?.basket;
  const corrections = priced?.corrections ?? [];
  const errors = response?.status === "invalid" ? response.errors : {};
  const coverageError = priced?.coverage === "invalid" ? "Enter a full UK postcode, for example SW1A 1AA."
    : priced?.coverage === "unsupported" ? "Online delivery isn’t available for this postcode."
      : undefined;

  function change<K extends keyof CheckoutFields>(name: K, value: CheckoutFields[K]) {
    if (materialValue(name, values[name]) !== materialValue(name, value)) attempt.current = null;
    setValues((current) => ({ ...current, [name]: value }));
    setResult(null);
  }

  function field(name: FieldName) {
    const config = fields[name] as (typeof fields)[FieldName] & { type?: string; optional?: boolean };
    const error = errors[name] ?? (name === "postcode" ? coverageError : undefined);
    return (
      <div className={name === "postcode" ? "checkout-field checkout-postcode" : "checkout-field"}>
        <label htmlFor={id + name}>{config.label}</label>
        <input
          id={id + name}
          name={name}
          type={config.type ?? "text"}
          autoComplete={config.autoComplete}
          required={!config.optional}
          value={values[name]}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? id + name + "-error" : undefined}
          onChange={(event) => change(name, event.target.value)}
        />
        {error && <p className="fine" id={id + name + "-error"}>{error}</p>}
        {name === "postcode" && priced?.coverage === "unsupported" && (
          <Link className="textlink" href="/enquiry?topic=delivery">Ask us about delivery</Link>
        )}
      </div>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current || !priced || !basket || corrections.length || priced.coverage === "unsupported") return;
    const form = event.currentTarget;
    const token = attempt.current?.revision === revision ? attempt.current.token : crypto.randomUUID();
    attempt.current = { token, revision };
    submitLock.current = true;
    setSubmitting(true);
    let invalid = false;
    try {
      const value = await checkoutReview({ attemptToken: token, lines, fields: values, quoteKey: priced.quoteKey });
      invalid = value.status === "invalid";
      setResult({ lines, value });
    } catch {
      setResult({ lines, value: { status: "error", message: "We couldn’t review your checkout. Try again." } });
    } finally {
      submitLock.current = false;
      setSubmitting(false);
      requestAnimationFrame(() => {
        const firstError = invalid ? form.querySelector<HTMLInputElement>('input[aria-invalid="true"]') : null;
        (firstError ?? feedback.current)?.focus();
      });
    }
  }

  if (!hydrated) return <p role="status">Loading your selection…</p>;
  if (!lines.length) {
    return (
      <section className="checkout-panel checkout-empty">
        <h2>Your selection is empty</h2>
        <p className="fine">Choose a blade from the catalogue to start an order.</p>
        <Link className="primary tray-action" href="/blades">Browse blades</Link>
      </section>
    );
  }

  return (
    <div className="checkout-grid">
      <section className="checkout-panel checkout-summary" aria-labelledby={id + "-summary"}>
        <div className="checkout-section-head">
          <h2 id={id + "-summary"} ref={summaryTitle} tabIndex={-1}>Order summary</h2>
          <button type="button" className="textlink" aria-haspopup="dialog" onClick={(event) => open(event.currentTarget)}>
            Edit selection
          </button>
        </div>
        <div role="status">
          {pending && response?.status !== "review" && <p className="fine">Checking prices and delivery…</p>}
          {shown?.status === "error" && <p className="fine">{shown.message}</p>}
          {response?.status === "review" && <p className="fine">{response.message}</p>}
          {corrections.length > 0 && (
            <div className="selection-notice">
              <p>Review the changes to your selection before continuing.</p>
              <ul>{corrections.map((message, index) => <li key={index}>{message}</li>)}</ul>
            </div>
          )}
        </div>
        {shown?.status === "error" && <button type="button" className="secondary tray-action" onClick={() => {
          setResult(null);
          retry();
        }}>Retry prices</button>}
        {basket && priced && (
          <>
            <ul className="selection-lines checkout-lines">
              {basket.lines.map((line) => (
                <li className="tray-line" key={line.variantId}>
                  <strong className="selection-code">{line.sku}</strong>
                  {line.optionLabel && <span className="fine">{line.optionLabel}</span>}
                  <SelectionLinePrice line={line} vatRate={basket.vatRateBasisPoints / 100} />
                </li>
              ))}
            </ul>
            <SelectionTotals quote={priced} />
            {priced.coverage === "unchecked" && <p className="fine">Delivery and the total are estimates until you enter your postcode.</p>}
            <DispatchEstimate quote={priced} />
          </>
        )}
        {corrections.length > 0 && priced && (
          <button type="button" className="secondary tray-action" onClick={() => {
            summaryTitle.current?.focus();
            setResult(null);
            replace(priced.lines);
          }}>Accept changes</button>
        )}
      </section>

      <form className="checkout-panel checkout-form" onSubmit={submit} noValidate>
        <fieldset disabled={submitting}>
          <legend>Business and contact</legend>
          {field("businessName")}
          {field("email")}
          <div className="checkout-field">
            <label className="checkout-check">
              <input
                type="checkbox"
                name="buyingForWork"
                required
                checked={values.buyingForWork}
                aria-invalid={!!errors.buyingForWork || undefined}
                aria-describedby={errors.buyingForWork ? id + "-business-error" : undefined}
                onChange={(event) => change("buyingForWork", event.target.checked)}
              />
              I’m buying for work
            </label>
            {errors.buyingForWork && <p className="fine" id={id + "-business-error"}>{errors.buyingForWork}</p>}
          </div>
        </fieldset>
        <fieldset disabled={submitting}>
          <legend>Delivery address</legend>
          {field("recipientName")}
          {field("line1")}
          {field("line2")}
          <div className="checkout-field-pair">{field("town")}{field("region")}</div>
          {field("postcode")}
          <p className="fine">Delivery country: United Kingdom</p>
        </fieldset>
        <div className="checkout-payment">
          {basket && (priced.coverage === "covered" || priced.coverage === "unchecked") && (
            <p className="checkout-amount"><span>{priced.coverage === "unchecked" ? "Estimated total inc VAT" : "Total inc VAT"}</span>
              <strong>{formatGbp(basket.totalGrossPence)}</strong></p>
          )}
          <button type="submit" className="primary full" disabled={submitting || !basket || corrections.length > 0 || priced?.coverage === "unsupported"}>
            {submitting ? "Checking checkout…" : "Continue to payment"}
          </button>
          <div role="status" ref={feedback} tabIndex={-1} className="checkout-feedback">
            {response?.status === "payment-unavailable" ? (
              <div className="selection-notice">
                <p><strong>Payment is not connected in this build.</strong></p>
                <p>No order was placed and you haven’t been charged.</p>
              </div>
            ) : (response?.status === "invalid" || response?.status === "error" || response?.status === "review") && (
              <p className="fine">{response.message}</p>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
