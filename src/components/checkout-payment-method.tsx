"use client";

import Link from "next/link";
import { formatGbp } from "@/lib/commerce";
import styles from "./checkout-payment-method.module.css";

export type TradeUnavailableReason = "not-approved" | "suspended" | "over-limit" | "unavailable";
export type CheckoutTrade = { status: "guest" | "not-approved" | "unavailable" }
  | { status: "approved" | "suspended"; availableCreditPence: number };

type TradeStatus = CheckoutTrade["status"] | "over-limit";

const tradeMessages = {
  guest: "Sign in with an approved trade account to use Net 30.",
  "not-approved": "Your trade account isn’t approved for Net 30.",
  suspended: "Your trade account is suspended for new orders.",
  "over-limit": "This order exceeds your available credit.",
  unavailable: "Pay on account is currently unavailable.",
} as const;

export function tradeUnavailableMessage(reason: TradeUnavailableReason) {
  return tradeMessages[reason];
}

export function CheckoutPaymentMethod({ id, status, available, gross, estimated, method, onMethod, locked, po, poError, onPo }: {
  id: string;
  status: TradeStatus;
  available?: number;
  gross?: number;
  estimated: boolean;
  method: "card" | "net30";
  onMethod: (method: "card" | "net30") => void;
  locked: boolean;
  po: string;
  poError?: string;
  onPo: (po: string) => void;
}) {
  const detail = status === "approved"
    ? locked ? "Close the previous card checkout before placing an order on account." : "We’ll invoice your trade account. Payment is due in 30 days."
    : tradeMessages[status];

  return (
    <fieldset>
      <legend>Payment method</legend>
      <div className={styles.option}>
        <label className="checkout-check">
          <input type="radio" name="paymentMethod" checked={method === "card"} onChange={() => onMethod("card")} />
          Card or wallet
        </label>
      </div>
      <div className={styles.option}>
        <label className="checkout-check">
          <input type="radio" name="paymentMethod" checked={method === "net30"} disabled={locked || status !== "approved"}
            aria-describedby={id + "-terms"} onChange={() => onMethod("net30")} />
          Pay on account (Net 30)
        </label>
        <p className="fine" id={id + "-terms"} aria-live="polite">{detail}</p>
        {status === "guest" && <Link className="textlink" href="/account">Sign in to your account</Link>}
        {status === "not-approved" && <Link className="textlink" href="/account">View your trade application</Link>}
        {(status === "approved" || status === "over-limit") && available !== undefined && (
          <dl className={styles.credit}>
            <div><dt>Available credit</dt><dd>{formatGbp(available)}</dd></div>
            {gross !== undefined && <div><dt>{estimated ? "Estimated order total inc VAT" : "Order total inc VAT"}</dt><dd>{formatGbp(gross)}</dd></div>}
          </dl>
        )}
        {method === "net30" && (
          <div className={`checkout-field ${styles.po}`}>
            <label htmlFor={id + "-po"}>Purchase order reference (required)</label>
            <input id={id + "-po"} name="poReference" required maxLength={200} value={po}
              aria-invalid={!!poError || undefined} aria-describedby={poError ? id + "-po-error" : undefined}
              onChange={(event) => onPo(event.target.value)} />
            {poError && <p className="fine" id={id + "-po-error"}>{poError}</p>}
          </div>
        )}
      </div>
    </fieldset>
  );
}
