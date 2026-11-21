import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";

let db: Client;

beforeAll(async () => {
  const url = process.env.SUPABASE_DB_URL;
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
    throw new Error("Run pnpm db:start and pnpm db:env against local Supabase.");
  }
  db = new Client({ connectionString: url, connectionTimeoutMillis: 3000, statement_timeout: 8000 });
  await db.connect();
});

afterAll(async () => db?.end());

test("enquiry replies enqueue once, matching never publishes an alias, and closing blocks new replies", async () => {
  const enquiryId = randomUUID();
  const deliveryId = randomUUID();
  const catalogueId = randomUUID();
  const warehouseId = randomUUID();
  const financeId = randomUUID();
  const key = randomUUID();
  const candidate = `CAND-${randomUUID().slice(0, 10)}`;
  const variant = (await db.query<{ id: string }>("select id from public.variants where publication_status = 'published' order by sku limit 1")).rows[0]!;
  for (const [id, role] of [[catalogueId, "catalogue"], [warehouseId, "warehouse"], [financeId, "finance"]]) {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@example.test`]);
    await db.query("insert into public.staff_members (user_id, role) values ($1, $2)", [id, role]);
  }
  const read = async (id = enquiryId) =>
    (await db.query<{ updated_at: string; status: string; matched_variant_id: string | null }>(
      "select updated_at::text, status, matched_variant_id from public.enquiries where id = $1", [id],
    )).rows[0]!;
  const change = (actor: string, action: string, version: string, options: {
    id?: string; key?: string; reply?: string; variant?: string; candidate?: string;
  } = {}) => db.query("select public.handle_admin_enquiry($1,$2,$3,$4,$5,$6,$7,$8)", [
    options.id ?? enquiryId, actor, action, version,
    options.key ?? null, options.reply ?? null, options.variant ?? null, options.candidate ?? null,
  ]);
  try {
    await db.query("select public.submit_enquiry($1,'compatibility','fixture@example.test','Will it fit?',$2,null,'zund')", [enquiryId, candidate]);
    await db.query("select public.submit_enquiry($1,'delivery','fixture@example.test','Can you deliver?',null,'SW1A 1AA')", [deliveryId]);
    await db.query("update public.enquiries set created_at = now() - interval '60 days' where id = $1", [enquiryId]);
    const start = (await read()).updated_at;
    const reply = { key, reply: "We are checking the holder." };
    await expect(change(financeId, "reply", start, reply)).rejects.toMatchObject({ code: "42501" });

    await db.query("set role authenticated");
    try {
      await expect(change(catalogueId, "reply", start, reply)).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("reset role");
    }

    await db.query("set role service_role");
    await change(warehouseId, "reply", start, reply);
    const replied = await read();
    expect(replied.status).toBe("replied");
    expect((await db.query("select created_at < now() - interval '30 days' as aged from public.enquiries where id = $1",
      [enquiryId])).rows).toEqual([{ aged: true }]);
    await change(warehouseId, "reply", start, reply);
    await expect(change(warehouseId, "reply", start, { ...reply, reply: "Changed text" })).rejects.toMatchObject({
      message: "enquiry_operation_conflict",
    });
    expect((await db.query(`select message_key, message_subject, message_body, state from public.order_outbox
      where enquiry_id = $1 and message_key like 'enquiry_reply:%'`, [enquiryId])).rows).toEqual([{
      message_key: `enquiry_reply:${key}`, message_subject: "Your Edgey enquiry", message_body: reply.reply, state: "pending",
    }]);
    await expect(db.query("select public.claim_outbox_email($1)", [`enquiry_reply:${key}`]))
      .rejects.toMatchObject({ message: "invalid_outbox_email_queue" });
    await db.query("begin");
    try {
      await db.query("select public.purge_request_data('30 days','30 days','30 days','30 days')");
      expect(await read()).toMatchObject({ status: "replied" });
    } finally {
      await db.query("rollback");
    }
    await expect(change(catalogueId, "match", start, { variant: variant.id })).rejects.toMatchObject({ message: "enquiry_stale" });
    await expect(change(catalogueId, "match", (await read(deliveryId)).updated_at, {
      id: deliveryId, variant: variant.id, candidate,
    })).rejects.toMatchObject({ message: "enquiry_cannot_match" });

    await change(warehouseId, "match", replied.updated_at, { variant: variant.id, candidate });
    expect(await read()).toMatchObject({ status: "converted", matched_variant_id: variant.id });
    expect((await db.query("select is_private, verification_state from public.compatibility where variant_id = $1 and code = $2",
      [variant.id, candidate])).rows).toEqual([{ is_private: true, verification_state: "candidate" }]);
    await change(catalogueId, "close", (await read()).updated_at);
    await expect(change(catalogueId, "reply", (await read()).updated_at, { key: randomUUID(), reply: "Another reply" }))
      .rejects.toMatchObject({ message: "enquiry_closed" });
    expect(await read()).toMatchObject({ status: "resolved", matched_variant_id: variant.id });

    for (const role of ["anon", "authenticated"]) {
      await db.query(`set role ${role}`);
      expect((await db.query("select code from public.compatibility where code = $1", [candidate])).rows).toEqual([]);
      expect((await db.query("select * from public.search_blades($1)", [candidate])).rows).toEqual([]);
    }
  } finally {
    await db.query("reset role");
    await db.query("delete from public.enquiries where id = any($1)", [[enquiryId, deliveryId]]);
    await db.query("delete from public.compatibility where variant_id = $1 and code = $2", [variant.id, candidate]);
    await db.query("delete from auth.users where id = any($1)", [[catalogueId, warehouseId, financeId]]);
  }
});
