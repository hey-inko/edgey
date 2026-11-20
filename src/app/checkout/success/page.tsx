import { createHash } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { formatGbp } from "@/lib/commerce";
import { checkoutSessionId } from "@/lib/payments/session-identity";
import { readCheckoutSuccess } from "@/lib/payments/success";
import { CheckoutStatus } from "./checkout-status";
import { ClearPaidSelection } from "./clear-paid-selection";
import styles from "./success.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Order confirmation",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeZone: "Europe/London" });
const vatRateFormat = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 2 });

type Props = { searchParams: Promise<{ session_id?: string | string[] }> };

export default async function CheckoutSuccessPage({ searchParams }: Props) {
  const { session_id: candidate } = await searchParams;
  const sessionId = typeof candidate === "string" && checkoutSessionId.test(candidate)
    ? candidate
    : null;
  const scope = sessionId && createHash("sha256").update(sessionId).digest("hex");
  const result = sessionId
    ? await readCheckoutSuccess(sessionId).catch(() => ({ kind: "unavailable" } as const))
    : null;
  const confirmation = result?.kind === "confirmed" ? result : null;

  return (
    <main id="main-content" tabIndex={-1} className="frame simple-page">
      <p className="kicker">
        <span className="register" aria-hidden="true" />
        Checkout
      </p>
      <CheckoutStatus key={scope} kind={result?.kind ?? "not-found"} />
      {confirmation && (
        <>
          {scope && <ClearPaidSelection scope={scope} lines={confirmation.lines.map(({ variantId, quantity }) => ({ variantId, quantity }))} />}
          <dl className={`specs ${styles.details}`}>
            <dt>Order reference</dt>
            <dd className={styles.figure}>{confirmation.reference}</dd>
            <dt>Dispatch date</dt>
            <dd><time dateTime={confirmation.dispatchDate}>{dateFormat.format(new Date(confirmation.dispatchDate))}</time></dd>
            <dt>Estimated delivery</dt>
            <dd><time dateTime={confirmation.deliveryDate}>{dateFormat.format(new Date(confirmation.deliveryDate))}</time></dd>
          </dl>
          <section aria-labelledby="order-summary" className={styles.summary}>
            <h2 id="order-summary" className={styles.summaryHeading}>Order summary</h2>
            <ul className={styles.lines} role="list">
              {confirmation.lines.map((line) => (
                <li key={line.variantId} className={styles.line}>
                  <div className={styles.item}>
                    <p className={styles.code}>{line.sku}</p>
                    <p>{line.optionLabel}</p>
                    <p className={styles.unit}>{line.quantity} × {formatGbp(line.unitPricePence)} ex VAT</p>
                  </div>
                  <p className={styles.figure}>{formatGbp(line.netPence)}</p>
                </li>
              ))}
            </ul>
            <dl className={styles.totals}>
              <div><dt>Subtotal ex VAT</dt><dd>{formatGbp(confirmation.goodsNetPence)}</dd></div>
              <div><dt>Delivery ex VAT</dt><dd>{formatGbp(confirmation.deliveryNetPence)}</dd></div>
              <div><dt>VAT ({vatRateFormat.format(confirmation.vatRateBps / 10_000)})</dt><dd>{formatGbp(confirmation.vatPence)}</dd></div>
              <div className={styles.total}><dt>Total paid inc VAT</dt><dd>{formatGbp(confirmation.grossPence)}</dd></div>
            </dl>
          </section>
        </>
      )}
      <div className="empty-actions">
        <Link className="textlink" href="/blades" prefetch={false}>Continue browsing</Link>
      </div>
    </main>
  );
}
