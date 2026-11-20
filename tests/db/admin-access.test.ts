import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createLocalAdminUser, localAdminClient } from "../../scripts/seed-admin";
import type { Database } from "../../src/lib/supabase/database.types";

const roles = ["warehouse", "catalogue", "finance", "buyer"] as const;
const service = localAdminClient();
const users = new Map<(typeof roles)[number], {
  id: string;
  client: ReturnType<typeof createClient<Database>>;
}>();

beforeAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  for (const role of roles) {
    const { id, email, password } = await createLocalAdminUser(role);
    const client = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    users.set(role, { id, client });
    const auth = await client.auth.signInWithPassword({ email, password });
    if (auth.error) throw auth.error;
    const verified = await client.auth.getUser();
    expect(verified.data.user?.id).toBe(id);
  }
});

afterAll(async () => {
  await Promise.all([...users.values()].map(({ id }) => service.auth.admin.deleteUser(id)));
});

test("authenticated clients can read only their own staff memberships and cannot assign a role", async () => {
  for (const role of roles) {
    const { client, id } = users.get(role)!;
    const own = await client.from("staff_members").select("user_id,role");
    expect(own.error).toBeNull();
    expect(own.data).toEqual(role === "buyer" ? [] : [{ user_id: id, role }]);
    const assign = await client.from("staff_members").insert({ user_id: id, role: "finance" });
    expect(assign.error?.code).toBe("42501");
  }
});

test("only the service API can invoke receipt mutations and it must supply a warehouse actor", async () => {
  const variant = await service.from("variants").select("id").eq("sku", "EDG-Z10").single();
  if (variant.error) throw variant.error;
  for (const [role, { client, id }] of users) {
    const payload = { p_variant_id: variant.data.id, p_operation_key: randomUUID(), p_quantity: 1, p_actor_id: id };
    const direct = await client.rpc("receive_stock", payload);
    expect(direct.error?.code).toBe("42501");
    if (role !== "warehouse") {
      const mutation = await service.rpc("receive_stock", payload);
      expect(mutation.error).toMatchObject({ code: "42501", message: "warehouse_role_required" });
    }
  }
});

test("only finance can read finance rows and its direct client cannot read confidential payload fields", async () => {
  const id = `evt_${randomUUID().replaceAll("-", "")}`;
  const recorded = await service.rpc("record_provider_event", {
    p_provider: "stripe", p_event_id: id, p_event_type: "checkout.session.completed", p_payload: { fixture: true },
  });
  expect(recorded.error).toBeNull();
  for (const [role, { client }] of users) {
    const event = await client.from("provider_events").select("provider,event_id,state").eq("event_id", id);
    expect(event.error).toBeNull();
    expect(event.data).toEqual(role === "finance" ? [{ provider: "stripe", event_id: id, state: "received" }] : []);
  }
  const { client } = users.get("finance")!;
  const payload = await client.from("provider_events").select("payload").eq("event_id", id);
  expect(payload.error?.code).toBe("42501");
});

test("only the finance retry RPC can mark a failed target, once per failure version", async () => {
  const finance = users.get("finance")!;
  const warehouse = users.get("warehouse")!;
  const id = `evt_${randomUUID().replaceAll("-", "")}`;
  const payload = { p_kind: "event", p_target_id: id, p_actor_id: finance.id };
  const record = await service.rpc("record_provider_event", {
    p_provider: "stripe", p_event_id: id, p_event_type: "fixture.replay", p_payload: { fixture: true },
  });
  expect(record.error).toBeNull();

  expect((await finance.client.rpc("request_finance_retry", payload)).error?.code).toBe("42501");
  expect((await service.rpc("request_finance_retry", { ...payload, p_actor_id: warehouse.id })).error)
    .toMatchObject({ code: "42501", message: "finance_role_required" });
  expect((await service.rpc("request_finance_retry", payload)).data).toBe(false);

  const fail = (message: string) => service.rpc("mark_provider_event", {
    p_provider: "stripe", p_event_id: id, p_state: "failed", p_error: message,
  });
  expect((await fail("Original failure")).error).toBeNull();
  const results = await Promise.all([service.rpc("request_finance_retry", payload), service.rpc("request_finance_retry", payload)]);
  expect(results.map(({ data, error }) => ({ data, error }))).toEqual([
    { data: true, error: null }, { data: true, error: null },
  ]);

  const list = () => finance.client.from("finance_retry_requests")
    .select("kind,target_id,target_updated_at,requested_at").eq("target_id", id).single();
  const initial = await list();
  expect(initial.error).toBeNull();
  expect(initial.data).toMatchObject({ kind: "event", target_id: id });
  expect((await warehouse.client.from("finance_retry_requests").select("target_id").eq("target_id", id)).data).toEqual([]);
  expect((await finance.client.from("finance_retry_requests").select("requested_by").eq("target_id", id)).error?.code).toBe("42501");
  expect((await fail("New failure")).error).toBeNull();
  expect((await service.rpc("request_finance_retry", payload)).data).toBe(true);
  const later = await list();
  expect(later.data?.target_updated_at).not.toBe(initial.data?.target_updated_at);
  expect((await service.from("provider_events").select("state,last_error").eq("event_id", id).single()).data)
    .toEqual({ state: "failed", last_error: "New failure" });
});

test("staff password attempts are limited separately from buyer magic links", async () => {
  const key = () => randomUUID().replaceAll("-", "").repeat(2);
  const p_ip_key = key();
  const p_email_key = key();
  for (let i = 0; i < 11; i++) {
    const attempt = await service.rpc("consume_request_rate_limit", { p_scope: "staff_sign_in", p_ip_key, p_email_key });
    expect(attempt.error).toBeNull();
    expect(attempt.data).toBe(i < 10);
  }
  const trade = await service.rpc("consume_request_rate_limit", { p_scope: "trade_sign_in", p_ip_key, p_email_key });
  expect(trade.error).toBeNull();
  expect(trade.data).toBe(true);
});
