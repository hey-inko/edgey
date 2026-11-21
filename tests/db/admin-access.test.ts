import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createLocalAdminUser, localAdminClient } from "../../scripts/seed-admin";
import type { Database } from "../../src/lib/supabase/database.types";
import { deleteStripeEventFixtures } from "../fixtures/stripe-events";
import { authenticatorCode } from "../helpers/authenticator";

const roles = ["warehouse", "catalogue", "finance", "buyer"] as const;
const service = localAdminClient();
const events: string[] = [];
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
    if (role !== "buyer") {
      const factor = await client.auth.mfa.enroll({ factorType: "totp" });
      if (factor.error) throw factor.error;
      const mfa = await client.auth.mfa.challengeAndVerify({
        factorId: factor.data.id, code: authenticatorCode(factor.data.totp.secret),
      });
      if (mfa.error) throw mfa.error;
      const approval = await service.rpc("activate_staff_authenticator", { p_user_id: id, p_factor_id: factor.data.id });
      if (approval.error) throw approval.error;
    }
  }
});

test("staff data requires a password and an operator-approved factor tied to the current GoTrue session", async () => {
  const { id, email, password } = await createLocalAdminUser("finance");
  const client = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const event = `evt_${randomUUID().replaceAll("-", "")}`;
  events.push(event);
  try {
    expect((await service.rpc("record_provider_event", {
      p_provider: "stripe", p_event_id: event, p_event_type: "fixture.event", p_payload: {},
    })).error).toBeNull();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    const read = () => client.from("provider_events").select("event_id").eq("event_id", event);
    expect(await read()).toMatchObject({ error: null, data: [] });
    const factor = await client.auth.mfa.enroll({ factorType: "totp" });
    if (factor.error) throw factor.error;
    const args = { p_user_id: id, p_factor_id: factor.data.id };
    expect((await service.rpc("activate_staff_authenticator", args)).error)
      .toMatchObject({ code: "22023", message: "verified_staff_factor_required" });
    const verify = await client.auth.mfa.challengeAndVerify({
      factorId: factor.data.id, code: authenticatorCode(factor.data.totp.secret),
    });
    expect(verify.error).toBeNull();
    expect(await client.rpc("get_staff_authenticator").single()).toMatchObject({
      error: null, data: { approved_factor_id: null, session_factor_id: factor.data.id },
    });
    expect(await read()).toMatchObject({ error: null, data: [] });
    expect((await client.rpc("activate_staff_authenticator", args)).error?.code).toBe("42501");
    expect((await service.rpc("activate_staff_authenticator", { ...args, p_user_id: users.get("warehouse")!.id })).error)
      .toMatchObject({ code: "22023", message: "verified_staff_factor_required" });
    expect((await service.rpc("activate_staff_authenticator", args)).error).toBeNull();
    expect(await read()).toMatchObject({ error: null, data: [{ event_id: event }] });
    const alternate = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Second fixture factor" });
    if (alternate.error) throw alternate.error;
    expect((await client.auth.mfa.challengeAndVerify({
      factorId: alternate.data.id, code: authenticatorCode(alternate.data.totp.secret),
    })).error).toBeNull();
    expect(await client.rpc("get_staff_authenticator").single()).toMatchObject({
      error: null, data: { approved_factor_id: factor.data.id, session_factor_id: alternate.data.id },
    });
    expect(await read()).toMatchObject({ error: null, data: [] });
    const link = await service.auth.admin.generateLink({ type: "magiclink", email });
    if (link.error) throw link.error;
    expect((await client.auth.signOut({ scope: "local" })).error).toBeNull();
    const magic = await client.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
    expect(magic.error).toBeNull();
    expect(await read()).toMatchObject({ error: null, data: [] });
  } finally {
    await service.auth.admin.deleteUser(id);
  }
});

afterAll(async () => {
  await deleteStripeEventFixtures(events);
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
  events.push(id);
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
  events.push(id);
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
