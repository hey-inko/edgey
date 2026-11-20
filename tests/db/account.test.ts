import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  accountInvoiceUrl,
  connectAccountDb,
  createAccountBuyer,
  createAccountCatalogue,
  createAccountOrder,
} from "../helpers/account-fixture";

let db: Client;

beforeAll(async () => { db = await connectAccountDb(); });
afterAll(() => db?.end());

async function asRole(role: "anon" | "authenticated", buyerId: string | undefined, read: () => Promise<void>) {
  await db.query("savepoint account_role");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, sub: buyerId })]);
    await db.query(`set local role ${role}`);
    await read();
  } finally {
    await db.query("rollback to savepoint account_role");
    await db.query("release savepoint account_role");
  }
}

async function rejects(sql: string, params: unknown[] = [], code = "42501") {
  await db.query("savepoint account_expect_error");
  try {
    await expect(db.query(sql, params)).rejects.toMatchObject({ code });
  } finally {
    await db.query("rollback to savepoint account_expect_error");
    await db.query("release savepoint account_expect_error");
  }
}

async function seedBuyers() {
  const { available } = await createAccountCatalogue(db);
  const order = (buyerId: string | null, email: string) => createAccountOrder(db, {
    buyerId, email, state: "dispatched", createdAt: "2026-11-17T10:00:00Z", invoice: true,
    lines: [{ ...available, quantity: 2, price: 2100 }],
  });
  const createBuyerWithHistory = async () => {
    const buyer = await createAccountBuyer(db);
    const applicationId = randomUUID();
    await db.query(`
      select public.submit_trade_application(
        $1, $2, 'Test Buyer', 'Account Test Studio', '12 Test Lane', 'London', 'SW1A 1AA'
      )
    `, [applicationId, buyer.id]);
    return { ...buyer, applicationId, order: await order(buyer.id, buyer.email) };
  };
  const buyerA = await createBuyerWithHistory();
  const buyerB = await createBuyerWithHistory();
  return {
    buyers: [buyerA, buyerB] as const,
    guest: await order(null, buyerA.email),
    variantId: available.id,
  };
}

describe("buyer account database isolation", () => {
  beforeEach(() => db.query("begin"));
  afterEach(() => db.query("rollback"));

  test("each verified buyer reads only their orders, items and trade application; a matching guest email confers no access", async () => {
    const { buyers, guest, variantId } = await seedBuyers();
    for (const buyer of buyers) {
      await asRole("authenticated", buyer.id, async () => {
        expect((await db.query("select role from public.staff_members")).rows).toEqual([]);
        expect((await db.query("select id, buyer_id, email from public.orders")).rows).toEqual([
          { id: buyer.order.id, buyer_id: buyer.id, email: buyer.email },
        ]);
        expect((await db.query("select order_id, variant_id, quantity from public.order_items")).rows).toEqual([
          { order_id: buyer.order.id, variant_id: variantId, quantity: 2 },
        ]);
        expect((await db.query("select id, buyer_id, status from public.trade_applications")).rows).toEqual([
          { id: buyer.applicationId, buyer_id: buyer.id, status: "pending" },
        ]);
        expect((await db.query("select id from public.orders where email = $1", [buyer.email])).rows)
          .not.toContainEqual({ id: guest.id });
      });
    }

    await asRole("anon", undefined, async () => {
      await rejects("select id from public.orders");
      await rejects("select order_id from public.order_items");
      await rejects("select id from public.trade_applications");
    });
  });

  test("buyers see only their own hosted invoice URL and cannot read provider invoice IDs or change order data", async () => {
    const { buyers, guest } = await seedBuyers();
    const allOrderIds = [...buyers.map(({ order }) => order.id), guest.id];
    for (const buyer of buyers) {
      await asRole("authenticated", buyer.id, async () => {
        expect((await db.query(
          "select id, buyer_invoice_url from public.orders where id = any($1::uuid[])", [allOrderIds],
        )).rows).toEqual([{ id: buyer.order.id, buyer_invoice_url: buyer.order.invoiceUrl }]);
        await rejects("select provider_invoice_id from public.orders where id = $1", [buyer.order.id]);
        await rejects("update public.orders set buyer_invoice_url = $2 where id = $1", [
          buyer.order.id, accountInvoiceUrl(randomUUID()),
        ]);
        await rejects("update public.orders set buyer_invoice_url = null where id = $1", [buyer.order.id]);
        await rejects("select public.set_buyer_invoice_url($1, $2, $3)", [
          buyer.order.id, buyer.order.providerInvoiceId, accountInvoiceUrl(randomUUID()),
        ]);
        await rejects("delete from public.orders where id = $1", [buyer.order.id]);
        await rejects("update public.order_items set option_label = 'Changed' where order_id = $1", [buyer.order.id]);
        await rejects("update public.trade_applications set company = 'Changed' where id = $1", [buyer.applicationId]);
      });
      expect((await db.query(
        "select buyer_invoice_url, provider_invoice_id from public.orders where id = $1", [buyer.order.id],
      )).rows).toEqual([{ buyer_invoice_url: buyer.order.invoiceUrl, provider_invoice_id: buyer.order.providerInvoiceId }]);
    }
    await asRole("anon", undefined, async () => {
      await rejects("select buyer_invoice_url from public.orders");
      await rejects("select public.set_buyer_invoice_url($1, $2, $3)", [
        guest.id, guest.providerInvoiceId, accountInvoiceUrl(randomUUID()),
      ]);
    });
  });

  test("an invoice URL is optional and constrained to hosted HTTPS Stripe invoices", async () => {
    const { buyers: [{ id, order }] } = await seedBuyers();
    for (const url of [
      "http://invoice.stripe.com/i/invst_example",
      "https://invoice.stripe.com.example.com/i/invst_example",
      "https://example.com/i/invst_example",
      "https://invoice.stripe.com/pay/invst_example",
      "https://invoice.stripe.com/i/",
    ]) {
      await rejects("update public.orders set buyer_invoice_url = $2 where id = $1", [order.id, url], "23514");
    }
    await db.query("update public.orders set buyer_invoice_url = null where id = $1", [order.id]);
    await asRole("authenticated", id, async () => {
      expect((await db.query("select buyer_invoice_url from public.orders where id = $1", [order.id])).rows)
        .toEqual([{ buyer_invoice_url: null }]);
    });
  });
});
