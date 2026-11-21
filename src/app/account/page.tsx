import Link from "next/link";
import { accountDate, fulfilmentLabels, orderPaymentLabel } from "@/lib/account/display";
import { listBuyerOrders } from "@/lib/account/server";
import { getBuyerTradeOverview } from "@/lib/account/trade";
import { sendAccountSignInLink, signOutOfAccount } from "@/lib/auth/actions";
import { getOwnTradeApplicationStatus, getVerifiedBuyer } from "@/lib/auth/server";
import { formatGbp } from "@/lib/commerce";
import { RequestForm } from "@/components/requests/request-form";
import { requestAvailability, requestsUnavailable } from "@/lib/requests/availability";
import styles from "./account.module.css";

const applicationStatus = {
  pending: { title: "Application pending", detail: "We’ll email you after we’ve reviewed it." },
  approved: { title: "Application approved", detail: "Net 30 isn’t available yet." },
  rejected: { title: "Application not approved", detail: "If you have questions about the decision, contact us." },
};

export default async function AccountPage({ searchParams }: {
  searchParams: Promise<{ signin?: string; signout?: string; page?: string }>;
}) {
  const [buyer, params] = await Promise.all([getVerifiedBuyer(), searchParams]);
  if (!buyer) {
    const availability = requestAvailability();
    return (
      <main id="main-content" tabIndex={-1} className="frame simple-page">
        <p className="kicker"><span className="register" aria-hidden="true" /> Buyer account</p>
        <h1>Sign in to your account</h1>
        <p className={`muted ${styles.signInIntro}`}>Use an email link to see orders linked to your account. Guest orders don’t appear here, even if they used the same email address.</p>
        {params.signin === "retry" && (
          <p className={styles.panel} role="status">We couldn’t verify the sign-in link. Request a new link and open it in this browser.</p>
        )}
        {availability.enabled ? (
          <RequestForm
            action={sendAccountSignInLink}
            fields={[{ name: "email", label: "Email address", type: "email", autoComplete: "email", required: true }]}
            submitLabel="Send sign-in link"
            successTitle="Check your email"
            successMessage="Open the sign-in link in this browser to continue."
            keepFormOnSuccess
          />
        ) : <p className={styles.panel} role="status">{requestsUnavailable}</p>}
        {"privacyUrl" in availability && (
          <p className={styles.privacy}><a className="textlink" href={availability.privacyUrl}>Privacy notice</a></p>
        )}
      </main>
    );
  }

  const page = typeof params.page === "string" && /^[1-9]\d{0,6}$/.test(params.page) ? Number(params.page) : 1;
  const [orderResult, applicationResult] = await Promise.allSettled([listBuyerOrders(page), getOwnTradeApplicationStatus()]);
  const history = orderResult.status === "fulfilled" ? orderResult.value : null;
  const status = applicationResult.status === "fulfilled" ? applicationResult.value : null;
  const trade = status === "approved" ? await getBuyerTradeOverview(buyer.id).catch(() => null) : null;

  return (
    <main id="main-content" tabIndex={-1} className={`frame ${styles.page}`}>
      <header className={styles.header}>
        <div>
          <p className="kicker"><span className="register" aria-hidden="true" /> Buyer account</p>
          <h1>Your account</h1>
          <p className="muted">Order history, dispatch and trade applications.</p>
        </div>
        <form action={signOutOfAccount} className={styles.session}>
          <p className="muted">Signed in as {buyer.email}</p>
          <button className="textlink" type="submit">Sign out</button>
          {params.signout === "retry" && <p role="alert">We couldn’t sign you out. Please try again.</p>}
        </form>
      </header>

      <div className={styles.columns}>
        <section aria-labelledby="orders-title">
          <h2 id="orders-title">Orders</h2>
          {orderResult.status === "rejected" ? (
            <p className={styles.panel}>We couldn’t load your orders. <Link className="textlink" href="/account">Try again</Link></p>
          ) : history?.orders.length ? (
            <ol className={styles.orderList} role="list">
              {history.orders.map((order) => (
                <li key={order.id} className={styles.orderRow}>
                  <div className={styles.orderHeader}>
                    <div>
                      <p className="eyebrow">Order reference</p>
                      <Link href={`/account/orders/${order.id}`} prefetch={false} className={`textlink ${styles.reference}`} aria-label={`View order ${order.order_reference}`}>{order.order_reference}</Link>
                    </div>
                    <time dateTime={order.created_at} className={styles.figure}>{accountDate(order.created_at)}</time>
                  </div>
                  <dl className={styles.facts}>
                    <div><dt>Payment</dt><dd>{orderPaymentLabel(order.payment_status, order.fulfilment_status)}</dd></div>
                    <div><dt>Fulfilment</dt><dd>{fulfilmentLabels[order.fulfilment_status]}</dd></div>
                    <div className={styles.orderTotal}><dt>Total inc VAT</dt><dd className={styles.figure}>{formatGbp(order.gross_pence)}</dd></div>
                  </dl>
                </li>
              ))}
            </ol>
          ) : (
            <div className={styles.panel}>
              <p>{page === 1 ? "You don’t have any orders on this account yet." : "There are no orders on this page."}</p>
              {page === 1 && <Link className="textlink" href="/blades">Browse blades</Link>}
            </div>
          )}
          {(page > 1 || history?.hasOlder) && (
            <nav aria-label="Order pages" className={styles.actions}>
              {page > 1 && <Link className="textlink" href={page === 2 ? "/account" : `/account?page=${page - 1}`}>Newer orders</Link>}
              {history?.hasOlder && <Link className="textlink" href={`/account?page=${page + 1}`}>Older orders</Link>}
            </nav>
          )}
        </section>

        <section aria-labelledby="trade-title">
          <h2 id="trade-title">Trade account</h2>
          <div className={styles.panel}>
            {applicationResult.status === "rejected" ? (
              <p>We couldn’t load your trade application status. Try again shortly.</p>
            ) : status ? (
              <>
                <h3>{applicationStatus[status].title}</h3>
                {(status !== "approved" || !trade) && <p className="muted">{applicationStatus[status].detail}</p>}
              </>
            ) : (
              <>
                <p>No trade application submitted.</p>
                <Link className="textlink" href="/trade">Apply for a trade account</Link>
              </>
            )}
            {status === "approved" && (
              <dl className={styles.tradeFacts}>
                <div><dt>Available credit</dt><dd>{trade ? <span className={styles.figure}>{formatGbp(trade.availableCreditPence)}</span> : "Not available yet"}</dd></div>
                <div><dt>Outstanding balance</dt><dd>{trade ? <span className={styles.figure}>{formatGbp(trade.outstandingBalancePence)}</span> : "Not available yet"}</dd></div>
                <div>
                  <dt>Invoices and PO references</dt>
                  <dd>{trade ? (
                    trade.invoices.length ? (
                      <ul className={styles.invoiceList} role="list">
                        {trade.invoices.map(({ orderId, poReference }) => (
                          <li key={orderId}><Link className="textlink" href={`/account/orders/${orderId}`}>Order {orderId}</Link> · PO {poReference}</li>
                        ))}
                      </ul>
                    ) : "No invoices"
                  ) : "Not available yet"}</dd>
                </div>
              </dl>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
