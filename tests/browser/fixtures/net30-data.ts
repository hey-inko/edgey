import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import type { BrowserContext } from "@playwright/test";
import type { Client } from "pg";
import { createLocalAdminUser } from "../../../scripts/seed-admin";
import { connectAccountDb } from "../../helpers/account-fixture";

export const company = "Northline Print Works";
export const buyerName = "Alex Morgan";
export const poReference = "PO-1042";
export const carrier = "Northline Parcel";
export const tracking = "NLP-72461042";
export const creditLimit = 20_000;
export const gross = 3_654;
export const partial = 1_500;

export async function signInBuyer(
  context: BrowserContext, origin: string, { email, password }: { email: string; password: string },
) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!["127.0.0.1", "localhost"].includes(URL.parse(url)?.hostname ?? "") || !key) {
    throw new Error("Buyer authentication needs the local Supabase Auth API.");
  }
  const cookies = new Map<string, string>();
  const client = createServerClient(url, key, {
    cookieOptions: { name: "edgey-auth" },
    cookies: {
      getAll: () => Array.from(cookies, ([name, value]) => ({ name, value })),
      setAll: (updates) => {
        for (const { name, value } of updates) {
          if (value) cookies.set(name, value);
          else cookies.delete(name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error || !cookies.size) throw new Error("Could not establish a local buyer session.");
  await context.addCookies(Array.from(cookies, ([name, value]) => ({
    name, value, url: origin, httpOnly: true, sameSite: "Lax" as const,
  })));
}

export type Net30Data = {
  db: Client;
  buyer: Awaited<ReturnType<typeof createLocalAdminUser>>;
  finance: Awaited<ReturnType<typeof createLocalAdminUser>>;
  warehouse: Awaited<ReturnType<typeof createLocalAdminUser>>;
  application: string;
  slug: string;
  sku: string;
  variantId: string;
  eventIds: string[];
  supabaseUrl: string;
};

export async function withNet30Data(provide: (data: Net30Data) => Promise<void>) {
  const db = await connectAccountDb();
  const userIds: string[] = [];
  const application = randomUUID();
  const productId = randomUUID();
  const variantId = randomUUID();
  const eventIds: string[] = [];
  const code = `EDG-N30-${productId.slice(0, 8).toUpperCase()}`;
  const slug = code.toLowerCase();
  const sku = code + "-45";
  try {
    const buyer = await createLocalAdminUser("buyer");
    userIds.push(buyer.id);
    const finance = await createLocalAdminUser("finance");
    userIds.push(finance.id);
    const warehouse = await createLocalAdminUser("warehouse");
    userIds.push(warehouse.id);
    await db.query("select public.submit_trade_application($1, $2, $3, $4, '12 Foundry Lane', 'London', 'SW1A 1AA')",
      [application, buyer.id, buyerName, company]);
    await db.query(`
      insert into public.products (id, family_code, slug, name, tool_category, sort_order)
      values ($1, $2, $3, 'Flat-stock drag blade', 'oscillating', 10000)
    `, [productId, code, slug]);
    await db.query(`
      insert into public.variants (id, product_id, sku, option_label, supplier_part_number, evidence_source,
        approved_at, publication_status, stock_on_hand, price_1_4_pence, price_5_9_pence, price_10_plus_pence)
      values ($1, $2, $3, '45°', $3, 'Local Net 30 fixture', now(), 'published', 20, 2350, 2100, 1850)
    `, [variantId, productId, sku]);
    await db.query(`
      insert into public.stock_movements (kind, operation_key, variant_id, on_hand_delta, reserved_delta)
      values ('opening', 'opening:' || $1::text, $1::uuid, 20, 0)
    `, [variantId]);
    await provide({
      db, buyer, finance, warehouse, application, slug, sku, variantId, eventIds,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    });
  } finally {
    try {
      await db.query("begin");
      const { rows } = await db.query<{ id: string }>(
        "select id from public.orders where buyer_id = any($1::uuid[])", [userIds],
      );
      const orderIds = rows.map(({ id }) => id);
      await db.query("delete from public.provider_events where provider = 'stripe' and event_id = any($1::text[])", [eventIds]);
      await db.query(`
        delete from public.credit_ledger where trade_account_id in (
          select id from public.trade_accounts where application_id = $1
        )
      `, [application]);
      await db.query("delete from public.stock_movements where variant_id = $1", [variantId]);
      for (const table of ["public.invoices", "public.credit_holds", "public.order_outbox",
        "private.order_operations", "public.stock_reservations", "public.order_items"]) {
        await db.query(`delete from ${table} where order_id = any($1::uuid[])`, [orderIds]);
      }
      await db.query("delete from public.orders where id = any($1::uuid[])", [orderIds]);
      await db.query("delete from public.trade_accounts where application_id = $1", [application]);
      await db.query("delete from public.trade_applications where id = $1", [application]);
      await db.query("delete from public.variants where id = $1", [variantId]);
      await db.query("delete from public.products where id = $1", [productId]);
      await db.query("delete from auth.users where id = any($1::uuid[])", [userIds]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      await db.end();
    }
  }
}
