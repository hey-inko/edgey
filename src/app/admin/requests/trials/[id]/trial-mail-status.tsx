import type { SupabaseClient } from "@supabase/supabase-js";
import { AdminNotice, AdminSection, AdminTable } from "@/app/admin/ui";
import { displayTimestamp } from "@/lib/admin/format";
import { commercialDb, type TrialMailKey, type TrialMailState } from "@/lib/commercial/database";
import type { Database } from "@/lib/supabase/database.types";

const messages: Record<TrialMailKey, string> = {
  confirmation: "Customer receipt",
  staff_notification: "Staff notification",
  trial_approved: "Approval",
  trial_declined: "Decline",
  trial_dispatched: "Dispatch",
};

const statuses: Record<TrialMailState, string> = {
  queued: "Queued",
  retrying: "Waiting to retry",
  sending: "Processing",
  sent: "Sent",
  failed: "Failed",
  unconfirmed: "Send unconfirmed",
  withdrawn: "Withdrawn before sending",
};

export async function TrialMailStatus({ db, id }: { db: SupabaseClient<Database>; id: string }) {
  const { data, error } = await commercialDb(db).rpc("admin_trial_mail_status", { p_trial_request_id: id });
  const byKey = new Map(data?.map((row) => [row.message_key, row]));
  return <AdminSection title="Trial email status">
    {error ? <AdminNotice>Email status is temporarily unavailable.</AdminNotice> :
      <AdminTable label="Trial email status" headers={["Message", "Status", "Sent at"]}>
        {(Object.keys(messages) as TrialMailKey[]).map((key) => {
          const message = byKey.get(key);
          return <tr key={key}>
            <th scope="row">{messages[key]}</th><td>{message ? statuses[message.status] : "Not queued"}</td>
            <td>{message?.sent_at ? displayTimestamp(message.sent_at) : "—"}</td>
          </tr>;
        })}
      </AdminTable>}
    <p className="admin-muted">Sent means the mail provider accepted the message; it does not confirm inbox delivery.</p>
  </AdminSection>;
}
