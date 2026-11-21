import { randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

let db: Client;
const stripeAccount = "acct_TradeApprovalFixture";

beforeAll(async () => {
  const url = process.env.SUPABASE_DB_URL;
  if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
    throw new Error("These tests need local Supabase. Run pnpm db:start && pnpm db:env.");
  }
  db = new Client({ connectionString: url, statement_timeout: 8_000 });
  await db.connect();
});
afterAll(() => db?.end());
beforeEach(() => db.query("begin"));
afterEach(() => db.query("rollback"));

async function one<T extends QueryResultRow>(sql: string, params: unknown[]) {
  const { rows } = await db.query<T>(sql, params);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function refused(sql: string, params: unknown[], code: string, message?: string) {
  await db.query("savepoint rejected_change");
  try {
    await expect(db.query(sql, params)).rejects.toMatchObject({ code, ...(message ? { message } : {}) });
  } finally {
    await db.query("rollback to savepoint rejected_change");
    await db.query("release savepoint rejected_change");
  }
}

async function fixture() {
  const buyer = randomUUID();
  const finance = randomUUID();
  const warehouse = randomUUID();
  const application = randomUUID();
  for (const id of [buyer, finance, warehouse]) {
    await db.query("insert into auth.users (id, email, email_confirmed_at, is_anonymous) values ($1,$2,now(),false)",
      [id, `${id}@example.test`]);
  }
  await db.query("insert into public.staff_members (user_id, role) values ($1,'finance'), ($2,'warehouse')", [finance, warehouse]);
  await db.query("select public.submit_trade_application($1,$2,'Alex Fixture','Print Fixture Ltd','1 Fixture Lane','London','SW1A 1AA')",
    [application, buyer]);
  const customer = `cus_${application.replaceAll("-", "")}`;
  return { application, buyer, finance, warehouse, customer };
}

const beginApproval = "select approval_started_at, approval_stripe_account_id from public.begin_trade_account_approval($1,$2,$3)";
const approve = "select public.review_admin_trade_application($1,$2,'approved',$3,$4)";
const reject = "select public.review_admin_trade_application($1,$2,'rejected',p_reason => $3)";
const decisions = "select message_key, message_subject, message_body from public.order_outbox where trade_application_id=$1 and message_key like 'trade_%'";

it("confines customer provisioning to the first sandbox and commits account approval and notice together", async () => {
  const { application, finance, warehouse, customer } = await fixture();
  await refused(beginApproval, [application, warehouse, stripeAccount], "42501", "finance_role_required");
  await refused(approve, [application, finance, 125000, customer], "22023", "trade_application_not_reviewable");
  const claim = await one(beginApproval, [application, finance, stripeAccount]);
  expect(claim.approval_started_at).toBeInstanceOf(Date);
  expect(claim.approval_stripe_account_id).toBe(stripeAccount);
  expect(await one(beginApproval, [application, finance, stripeAccount])).toEqual(claim);
  await refused(beginApproval, [application, finance, "acct_OtherSandbox"], "22023", "trade_approval_stripe_account_mismatch");
  await refused(reject, [application, finance, "Decision conflicts with provisioning"], "22023", "trade_application_not_reviewable");
  await refused(approve, [application, finance, -1, customer], "22023", "invalid_trade_account_terms");
  expect(await one("select status from public.trade_applications where id=$1", [application])).toEqual({ status: "pending" });
  expect((await db.query(decisions, [application])).rowCount).toBe(0);

  await db.query(approve, [application, finance, 125000, customer]);
  const account = await one("select id, status, stripe_customer_id from public.trade_accounts where application_id=$1", [application]);
  expect(account).toMatchObject({ status: "approved", stripe_customer_id: customer });
  await db.query("select public.set_credit_limit($1,$2,$3,80000)", [account.id, finance, randomUUID()]);
  await db.query(approve, [application, finance, 125000, customer]);
  expect(await one("select credit_limit_pence from public.trade_accounts where id=$1", [account.id])).toEqual({ credit_limit_pence: 80000 });
  expect(await one(decisions, [application])).toMatchObject({
    message_key: "trade_approved", message_subject: "Your Edgey trade account is approved",
  });
});

it("keeps the rejection reason private, queues one neutral notice, and denies direct RPC access", async () => {
  const { application, finance, buyer, warehouse } = await fixture();
  const reason = "Private test: initial risk checks not met";
  await refused(reject, [application, warehouse, reason], "42501", "finance_role_required");
  await refused(reject, [application, finance, " "], "22023", "trade_rejection_reason_required");
  await db.query(reject, [application, finance, reason]);
  await db.query(reject, [application, finance, ` ${reason} `]);
  expect(await one("select status,rejection_reason from public.trade_applications where id=$1", [application])).toEqual({
    status: "rejected", rejection_reason: reason,
  });
  const notice = await one(decisions, [application]);
  expect(notice.message_key).toBe("trade_rejected");
  expect(notice.message_body).not.toContain(reason);
  expect((await db.query("select id from public.trade_accounts where application_id=$1", [application])).rowCount).toBe(0);

  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: buyer })]);
  await db.query("set local role authenticated");
  await refused("select rejection_reason from public.trade_applications where id=$1", [application], "42501");
  await refused(reject, [application, finance, reason], "42501");
  await db.query("reset role");
});

it("reinstates only suspended accounts and never replays an old change over a newer suspension", async () => {
  const { application, finance, warehouse, customer } = await fixture();
  await db.query(beginApproval, [application, finance, stripeAccount]);
  await db.query(approve, [application, finance, 125000, customer]);
  const { id } = await one("select id from public.trade_accounts where application_id=$1", [application]);
  const reinstate = "select status from public.reinstate_trade_account($1,$2,$3,$4)";
  const operation = randomUUID();
  await refused(reinstate, [id, finance, operation, "Open again"], "22023", "trade_account_not_suspended");
  await db.query("select public.suspend_trade_account($1,$2,$3,'Payment review')", [id, finance, randomUUID()]);
  await refused(reinstate, [id, warehouse, operation, "Open again"], "42501", "finance_role_required");
  expect(await one(reinstate, [id, finance, operation, "Open again"])).toEqual({ status: "approved" });
  await db.query("select public.suspend_trade_account($1,$2,$3,'New review')", [id, finance, randomUUID()]);
  expect(await one(reinstate, [id, finance, operation, "Open again"])).toEqual({ status: "suspended" });
  expect(await one("select input, held_delta_pence, outstanding_delta_pence from public.credit_ledger where operation_key=$1", [operation]))
    .toEqual({ input: ["Open again"], held_delta_pence: 0, outstanding_delta_pence: 0 });
});
