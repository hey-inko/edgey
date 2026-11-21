import { formatGbp } from "@/lib/commerce";
import { requireStaff } from "@/lib/admin/auth";
import { financeOverview } from "@/lib/admin/finance";
import { displayState, displayTimestamp } from "@/lib/admin/format";
import { adminPage, adminPageSize } from "@/lib/admin/pagination";
import { AdminPagination } from "../pagination";
import { AdminForm, AdminHeading, AdminNotice, AdminSection, AdminTable } from "../ui";
import { retryFinanceFailure } from "./actions";

type Search = Record<string, string | string[] | undefined>;

export const metadata = { title: "Finance" };

export default async function FinancePage({ searchParams }: { searchParams: Promise<Search> }) {
  const { db } = await requireStaff("finance");
  const query = await searchParams;
  const pages = {
    orders: adminPage(query.orders), captures: adminPage(query.captures), reviews: adminPage(query.reviews),
    events: adminPage(query.events), outbox: adminPage(query.outbox),
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
      <AdminHeading title="Finance" description="Review payment exceptions and request retries. Refunds are handled separately with the payment provider." />
      <AdminSection title="Payment review">
        {overview.reviews.length ? (
          <AdminTable label="Payment review" headers={["Order", "Business", "Payment", "Reason"]}>
            {overview.reviews.slice(0, adminPageSize).map((order) => <tr key={order.id}>
              <td className="admin-mono">{order.id}</td><td>{order.business_name}</td>
              <td>{displayState(order.payment_status)}</td>
              <td>{order.payment_review_reason ? displayState(order.payment_review_reason) : order.stripe_reconciliation_error}</td>
            </tr>)}
          </AdminTable>
        ) : <AdminNotice>No orders to review on this page.</AdminNotice>}
        {nav("reviews")}
      </AdminSection>
      <AdminSection title="Cancelled orders with outstanding capture">
        {overview.captures.length ? (
          <AdminTable label="Outstanding captures" headers={["Order", "Business", "Payment", "Outstanding"]}>
            {overview.captures.slice(0, adminPageSize).map((order) => <tr key={order.id}>
              <td className="admin-mono">{order.id}</td><td>{order.business_name}</td>
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
          <AdminTable label="Orders and payment status" headers={["Order", "Business", "Payment", "Fulfilment", "Total", "Created"]}>
            {overview.orders.slice(0, adminPageSize).map((order) => <tr key={order.id}>
              <td className="admin-mono">{order.id}</td><td>{order.business_name}</td>
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
