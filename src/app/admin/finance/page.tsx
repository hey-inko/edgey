import { formatGbp } from "@/lib/commerce";
import { requireStaff } from "@/lib/admin/auth";
import { financeOverview } from "@/lib/admin/finance";
import { displayState, displayTimestamp } from "@/lib/admin/format";
import { adminPage, adminPageSize } from "@/lib/admin/pagination";
import { amountMismatch } from "@/lib/admin/payment-review";
import { AdminPagination } from "../pagination";
import { AdminForm, AdminHeading, AdminLink, AdminNotice, AdminSection, AdminTable } from "../ui";
import { resolveFinancePaymentReview, retryFinanceFailure, voidFinanceInvoice } from "./actions";

type Search = Record<string, string | string[] | undefined>;

export const metadata = { title: "Finance" };

export default async function FinancePage({ searchParams }: { searchParams: Promise<Search> }) {
  const { db } = await requireStaff("finance");
  const query = await searchParams;
  const pages = {
    orders: adminPage(query.orders), captures: adminPage(query.captures), reviews: adminPage(query.reviews),
    events: adminPage(query.events), outbox: adminPage(query.outbox),
    accounts: adminPage(query.accounts), overdue: adminPage(query.overdue), voids: adminPage(query.voids),
  };
  const overview = await financeOverview(db, pages);
  const requested = new Map(overview.queued.map(({ kind, target_id, target_updated_at, result }) =>
    [`${kind}:${target_id}:${target_updated_at}`, result]));
  const replayLabel = (key: string) => {
    const result = requested.get(key);
    if (result === undefined) return null;
    if (result === null) return "Retry queued.";
    if (result === "not_replayable") return "A safe retry isn’t available.";
    return `Retry outcome: ${displayState(result)}`;
  };
  const nav = (key: keyof typeof pages) => (
    <AdminPagination pathname="/admin/finance" query={query} parameter={key}
      page={pages[key]} length={overview[key].length} />
  );

  return (
    <>
      <AdminHeading title="Finance" description="Manage Net 30 accounts, follow up overdue invoices and review payment exceptions." />
      <AdminLink href="/admin/requests">Review trade applications</AdminLink>
      <AdminSection title="Trade accounts">
        {overview.accounts.length ? (
          <AdminTable label="Trade accounts" headers={["Business", "Named buyer", "Net 30 status", "Credit limit"]}>
            {overview.accounts.slice(0, adminPageSize).map((account) => <tr key={account.id}>
              <td><AdminLink href={`/admin/finance/accounts/${account.id}`}>{account.trade_applications?.company ?? account.buyer_name}</AdminLink></td>
              <td>{account.buyer_name}</td><td>{displayState(account.status)}</td>
              <td className="admin-mono">{formatGbp(account.credit_limit_pence)}</td>
            </tr>)}
          </AdminTable>
        ) : <AdminNotice>No trade accounts on this page.</AdminNotice>}
        {nav("accounts")}
      </AdminSection>
      <AdminSection title="Overdue follow-up">
        {overview.overdue.length ? (
          <AdminTable label="Overdue invoices" headers={["Account", "Billing contact", "PO", "Due", "Outstanding"]}>
            {overview.overdue.slice(0, adminPageSize).map((invoice) => {
              const contact = overview.overdueContacts.get(invoice.trade_account_id);
              return <tr key={invoice.order_id}>
                <td><AdminLink href={`/admin/finance/accounts/${invoice.trade_account_id}`}>{contact?.company ?? "View account"}</AdminLink></td>
                <td className="admin-mono">{contact?.email ?? "—"}</td>
                <td className="admin-mono">{invoice.po_number}</td>
                <td className="admin-mono">{displayTimestamp(invoice.due_at)}</td>
                <td className="admin-mono">{formatGbp(invoice.amount_remaining_pence)}</td>
              </tr>;
            })}
          </AdminTable>
        ) : <AdminNotice>No overdue invoices on this page.</AdminNotice>}
        {nav("overdue")}
      </AdminSection>
      <AdminSection title="Cancelled orders with unpaid invoices">
        {overview.voids.length ? (
          <>
            <p className="admin-muted">Void the invoice only after the order is cancelled and before it has been paid or dispatched. Edgey checks Stripe before releasing the outstanding balance.</p>
            <AdminTable label="Cancelled Net 30 orders" headers={["Order", "Business", "PO", "Gross", "Action"]}>
              {overview.voids.slice(0, adminPageSize).map((order) => <tr key={order.id}>
                <td className="admin-mono">{order.order_reference}</td>
                <td>{order.trade_account_id ? <AdminLink href={`/admin/finance/accounts/${order.trade_account_id}`}>{order.business_name}</AdminLink> : order.business_name}</td>
                <td className="admin-mono">{order.po_number}</td>
                <td className="admin-mono">{formatGbp(order.gross_pence)}</td>
                <td>
                  <AdminForm action={voidFinanceInvoice.bind(null, order.id)} submit="Verify and void invoice">
                    <label className="admin-check"><input type="checkbox" name="confirm" value="yes" required /> Confirm void</label>
                  </AdminForm>
                </td>
              </tr>)}
            </AdminTable>
          </>
        ) : <AdminNotice>No cancelled orders with unpaid invoices on this page.</AdminNotice>}
        {nav("voids")}
      </AdminSection>
      <AdminSection title="Payment review">
        {overview.reviews.some((order) => order.payment_method === "card" && order.payment_review_reason === amountMismatch) &&
          <p className="admin-muted">Refund a mismatched payment in Stripe first. Edgey closes the review only after verifying the full refund.</p>}
        {overview.reviews.length ? (
          <AdminTable label="Payment review" headers={["Order", "Business", "Payment", "Reason", "Action"]}>
            {overview.reviews.slice(0, adminPageSize).map((order) => <tr key={order.id}>
              <td className="admin-mono">{order.order_reference}</td><td>{order.business_name}</td>
              <td>{displayState(order.payment_status)}</td>
              <td>{order.stripe_reconciliation_error ?? (order.payment_review_reason && displayState(order.payment_review_reason))}</td>
              <td>{order.payment_method === "card" && order.payment_review_reason === amountMismatch
                ? <AdminForm action={resolveFinancePaymentReview.bind(null, order.id)} submit="Verify full refund">
                    {order.payment_intent_id && <a className="textlink" href={`https://dashboard.stripe.com/test/payments/${encodeURIComponent(order.payment_intent_id)}`}>Stripe payment</a>}
                  </AdminForm> : "—"}</td>
            </tr>)}
          </AdminTable>
        ) : <AdminNotice>No orders to review on this page.</AdminNotice>}
        {nav("reviews")}
      </AdminSection>
      <AdminSection title="Cancelled orders with outstanding capture">
        {overview.captures.length ? (
          <AdminTable label="Outstanding captures" headers={["Order", "Business", "Payment", "Outstanding"]}>
            {overview.captures.slice(0, adminPageSize).map((order) => <tr key={order.id}>
              <td className="admin-mono">{order.order_reference}</td><td>{order.business_name}</td>
              <td>{displayState(order.payment_status)}</td>
              <td className="admin-mono">{formatGbp(order.paid_pence - order.refunded_pence)}</td>
            </tr>)}
          </AdminTable>
        ) : <AdminNotice>No outstanding captures on this page.</AdminNotice>}
        {nav("captures")}
      </AdminSection>
      <AdminSection title="Failed provider events">
        {overview.events.length ? (
          <AdminTable label="Failed provider events" headers={["Event", "Type", "Last error", "Retry"]}>
            {overview.events.slice(0, adminPageSize).map((event) => <tr key={`${event.provider}:${event.event_id}`}>
              <td className="admin-mono">{event.event_id}</td><td>{event.event_type}</td><td>{event.last_error}</td>
              <td>{event.provider !== "stripe" ? "No replay available" : replayLabel(`event:${event.event_id}:${event.updated_at}`) ?? (
                <AdminForm action={retryFinanceFailure.bind(null, { kind: "event", id: event.event_id })} submit="Reprocess event" />
              )}</td>
            </tr>)}
          </AdminTable>
        ) : <AdminNotice>No failed provider events on this page.</AdminNotice>}
        {nav("events")}
      </AdminSection>
      <AdminSection title="Confirmation outbox">
        {overview.outbox.length ? (
          <AdminTable label="Confirmation outbox" headers={["Order", "Status", "Last error", "Updated", "Retry"]}>
            {overview.outbox.slice(0, adminPageSize).map((message) => <tr key={message.order_id}>
              <td className="admin-mono">
                {message.orders?.order_reference && <span className="block">{message.orders.order_reference}</span>}
                {message.order_id}
              </td><td>{displayState(message.state)}</td>
              <td>{message.last_error ? displayState(message.last_error) : "—"}</td>
              <td className="admin-mono">{displayTimestamp(message.updated_at)}</td><td>{message.state !== "failed" || !message.order_id ? "—" :
              replayLabel(`confirmation:${message.order_id}:${message.updated_at}`) ?? (
                <AdminForm action={retryFinanceFailure.bind(null, { kind: "confirmation", id: message.order_id })} submit="Resend confirmation" />
              )}</td>
            </tr>)}
          </AdminTable>
        ) : <AdminNotice>No pending or failed confirmations on this page.</AdminNotice>}
        {nav("outbox")}
      </AdminSection>
      <AdminSection title="Orders">
        {overview.orders.length ? (
          <AdminTable label="Orders and payment status" headers={["Order", "Business", "Method", "Payment", "Fulfilment", "Total", "Created"]}>
            {overview.orders.slice(0, adminPageSize).map((order) => <tr key={order.id}>
              <td className="admin-mono">{order.order_reference}</td><td>{order.business_name}</td>
              <td>{order.payment_method === "net30" ? "Net 30" : "Card"}</td>
              <td>{displayState(order.payment_status)}</td><td>{displayState(order.fulfilment_status)}</td>
              <td className="admin-mono">{formatGbp(order.gross_pence)}</td>
              <td className="admin-mono">{displayTimestamp(order.created_at)}</td>
            </tr>)}
          </AdminTable>
        ) : <AdminNotice>No orders on this page.</AdminNotice>}
        {nav("orders")}
      </AdminSection>
    </>
  );
}
