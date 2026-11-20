"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import styles from "./success.module.css";

const copy = {
  confirmed: {
    heading: "Order confirmed",
    details: "We’ll email your order confirmation and invoice access.",
  },
  pending: {
    heading: "Confirming payment",
    details: "We’re waiting for confirmation. You don’t need to pay again.",
  },
  expired: {
    heading: "This checkout has expired",
    details: "We don’t have a confirmed payment for this checkout.",
  },
  review: {
    heading: "Your payment is under review",
    details: "Your order isn’t confirmed yet. Please don’t pay again while we review it.",
  },
  "not-found": {
    heading: "Checkout not found",
    details: "Use the link you were given after checkout to check your order.",
  },
  unavailable: {
    heading: "We can’t check your payment right now",
    details: "Try checking again in a moment. You don’t need to pay again.",
  },
};

const pollIntervalMs = 3000;
const maxAutomaticChecks = 10;

export function CheckoutStatus({ kind }: { kind: keyof typeof copy }) {
  const router = useRouter();
  const [checking, startTransition] = useTransition();
  const [checks, setChecks] = useState(0);
  const canRetry = kind === "pending" || kind === "unavailable";
  const automaticChecksEnded = kind === "pending" && checks >= maxAutomaticChecks && !checking;

  useEffect(() => {
    if (kind !== "pending" || checks >= maxAutomaticChecks || checking) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      window.clearInterval(timer);
      setChecks((count) => count + 1);
      startTransition(() => router.refresh());
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [checking, checks, kind, router]);

  function checkAgain() {
    setChecks(0);
    startTransition(() => router.refresh());
  }

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h1>{copy[kind].heading}</h1>
        <p className={styles.message}>
          {automaticChecksEnded ? "This is taking longer than expected. You can check again below. You don’t need to pay again." : copy[kind].details}
        </p>
      </div>
      {canRetry && (
        <button className={`textlink ${styles.retry}`} type="button" onClick={checkAgain} disabled={checking}>
          Check payment status
        </button>
      )}
    </>
  );
}
