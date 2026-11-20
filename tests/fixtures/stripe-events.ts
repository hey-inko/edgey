import { Client } from "pg";

export async function deleteStripeEventFixtures(eventIds: string[], confirmationOrderId?: string) {
  if (!eventIds.length) return;
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString || !["127.0.0.1", "localhost"].includes(new URL(connectionString).hostname)) {
    throw new Error("Only the local test database can be used for Stripe fixture cleanup.");
  }
  const db = new Client({ connectionString, statement_timeout: 5_000 });
  await db.connect();
  try {
    await db.query("delete from public.finance_retry_requests where kind = 'event' and target_id = any($1)", [eventIds]);
    await db.query("delete from public.provider_events where provider = 'stripe' and event_id = any($1)", [eventIds]);
    if (confirmationOrderId) {
      await db.query("delete from public.finance_retry_requests where kind = 'confirmation' and target_id = $1", [confirmationOrderId]);
    }
  } finally {
    await db.end();
  }
}
