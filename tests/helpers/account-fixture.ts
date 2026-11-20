import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Client } from "pg";

export type AccountBuyer = { id: string; email: string };

export const accountEmail = () => `account-${randomUUID()}@example.com`;

export async function connectAccountDb() {
  if (!process.env.SUPABASE_DB_URL && existsSync(".env.local")) process.loadEnvFile(".env.local");
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString || !["127.0.0.1", "localhost"].includes(new URL(connectionString).hostname)) {
    throw new Error("Account tests need a local Supabase stack. Run pnpm db:start && pnpm db:env.");
  }
  const db = new Client({ connectionString, connectionTimeoutMillis: 3000, statement_timeout: 8000 });
  await db.connect();
  return db;
}

export async function createAccountBuyer(db: Client): Promise<AccountBuyer> {
  const buyer = { id: randomUUID(), email: accountEmail() };
  await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [
    buyer.id, buyer.email,
  ]);
  return buyer;
}

export async function createAccountCatalogue(db: Client) {
  const productId = randomUUID();
  const code = `ACCT-${productId.slice(0, 8).toUpperCase()}`;
  await db.query(`
    insert into public.products (id, family_code, slug, name, tool_category, sort_order)
    values ($1, $2, lower($2), 'Account test blades', 'oscillating', 10000)
  `, [productId, code]);
  const variants = {
    available: { id: randomUUID(), sku: code + "-45", label: "45° drag blade", stock: 20 },
    soldOut: { id: randomUUID(), sku: code + "-60", label: "60° drag blade", stock: 0 },
    selected: { id: randomUUID(), sku: code + "-30", label: "30° drag blade", stock: 20 },
  };
  for (const { id, sku, label, stock } of Object.values(variants)) {
    await db.query(`
      insert into public.variants (id, product_id, sku, option_label, supplier_part_number, evidence_source,
        approved_at, publication_status, stock_on_hand, price_1_4_pence, price_5_9_pence, price_10_plus_pence)
      values ($1, $2, $3, $4, $3, 'Account test fixture', now(), 'published', $5, 2350, 2100, 1850)
    `, [id, productId, sku, label, stock]);
    if (stock > 0) {
      await db.query(`
        insert into public.stock_movements (kind, operation_key, variant_id, on_hand_delta, reserved_delta)
        values ('opening', 'opening:' || $1::text, $1::uuid, $2, 0)
      `, [id, stock]);
    }
  }
  return { productId, ...variants };
}

type OrderState = "dispatched" | "pending" | "refunded";

export function accountInvoiceUrl(id: string) {
  return `https://invoice.stripe.com/i/acct_edgey_test/invst_${id}`;
}

export async function createAccountOrder(db: Client, input: {
  buyerId: string | null;
  email: string;
  state: OrderState;
  createdAt: string;
  lines: { id: string; sku: string; label: string; quantity: number; price: number }[];
  invoice?: boolean;
}) {
  const id = randomUUID();
  const { state, lines } = input;
  const goods = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
  const delivery = 695;
  const vat = (goods + delivery) / 5;
  const gross = goods + delivery + vat;
  const invoiceUrl = input.invoice ? accountInvoiceUrl(id) : null;
  const providerInvoiceId = input.invoice ? `in_test_${id}` : null;
  const dispatched = state === "dispatched";
  await db.query(`
    insert into public.orders (
      id, checkout_attempt_token, buyer_id, email, business_name, recipient_name, buying_for_work,
      address_line1, address_town, address_postcode, address_country,
      payment_status, fulfilment_status, goods_net_pence, delivery_net_pence, vat_rate_bps, vat_pence,
      gross_pence, paid_pence, refunded_pence, hold_expires_at, delivery_service, promised_dispatch_date,
      estimated_delivery_date, authorised_at, dispatched_at, carrier, tracking_number,
      buyer_invoice_url, provider_invoice_id, created_at
    ) values (
      $1, $2, $3, $4, 'Account Test Studio', 'Test Buyer', true,
      '12 Test Lane', 'London', 'SW1A 1AA', 'GB',
      $5, $6, $7, $8, 2000, $9, $10, $11, $12, $13::timestamptz + interval '30 minutes',
      'Next working day', '2026-11-18', '2026-11-19', $14, $15, $16, $17, $18, $19, $13
    )
  `, [
    id, randomUUID(), input.buyerId, input.email,
    dispatched ? "paid" : state,
    dispatched ? "dispatched" : state === "refunded" ? "cancelled" : "awaiting_authorisation",
    goods, delivery, vat, gross, state === "pending" ? 0 : gross, state === "refunded" ? gross : 0,
    input.createdAt, state === "pending" ? null : input.createdAt,
    dispatched ? "2026-11-18T11:00:00Z" : null,
    dispatched ? "Fixture Parcel Service" : null, dispatched ? "EDGEY-TEST-7246" : null,
    invoiceUrl, providerInvoiceId,
  ]);
  for (const line of lines) {
    const net = line.price * line.quantity;
    await db.query(`
      insert into public.order_items
        (order_id, variant_id, sku, option_label, quantity, unit_price_pence, net_pence, tax_pence, gross_pence)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [id, line.id, line.sku, line.label, line.quantity, line.price, net, net / 5, net + net / 5]);
  }
  return { id, invoiceUrl, providerInvoiceId };
}
