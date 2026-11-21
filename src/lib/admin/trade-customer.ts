import "server-only";

import type Stripe from "stripe";
import type { Database } from "@/lib/supabase/database.types";
import { isWarehouseId } from "./warehouse-format";

type Application = Pick<Database["public"]["Tables"]["trade_applications"]["Row"],
  "id" | "approval_started_at" | "company" | "email" | "billing_line1" | "billing_line2" | "billing_town" | "billing_postcode"
>;

const customerId = /^cus_[A-Za-z0-9]{1,196}$/;

export class TradeCustomerReviewError extends Error {}

export async function provisionTradeCustomer(stripe: Stripe, application: Application, now = Date.now()) {
  const startedAt = application.approval_started_at && Date.parse(application.approval_started_at);
  if (!isWarehouseId(application.id) || typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
    throw new TradeCustomerReviewError("This application has no recorded Stripe provisioning attempt.");
  }
  const expected = {
    name: application.company,
    email: application.email,
    address: {
      line1: application.billing_line1,
      line2: application.billing_line2 ?? undefined,
      city: application.billing_town,
      postal_code: application.billing_postcode,
      country: "GB",
    },
    metadata: { edgey_trade_application_id: application.id },
  };
  const matches = await stripe.customers.search({
    query: `metadata['edgey_trade_application_id']:'${application.id}'`,
    limit: 2,
  });
  if (matches.has_more || matches.data.length > 1) {
    throw new TradeCustomerReviewError("More than one Stripe customer matches this application. Resolve the duplicate in Stripe before approving.");
  }
  const age = now - startedAt;
  if (!matches.data.length && (age < -60_000 || age >= 23 * 60 * 60_000)) {
    throw new TradeCustomerReviewError("No matching Stripe customer was found and it’s too late to safely retry creation. Check the application reference in Stripe before approving.");
  }
  const match = matches.data[0];
  const customer = match ? await stripe.customers.retrieve(match.id) :
    await stripe.customers.create(expected, { idempotencyKey: `edgey-trade-customer:${application.id}` });
  if (customer.deleted || (match && customer.id !== match.id) || !customerId.test(customer.id) || customer.livemode !== false ||
    customer.metadata?.edgey_trade_application_id !== application.id ||
    customer.name !== expected.name || customer.email !== expected.email ||
    customer.address?.line1 !== expected.address.line1 ||
    (customer.address.line2 ?? undefined) !== expected.address.line2 ||
    customer.address.city !== expected.address.city || customer.address.postal_code !== expected.address.postal_code ||
    customer.address.country !== expected.address.country) {
    throw new TradeCustomerReviewError("The Stripe customer’s billing details or application reference don’t match. Check the Stripe record before approving.");
  }
  return customer.id;
}
