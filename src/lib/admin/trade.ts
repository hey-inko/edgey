import "server-only";

import { stripeAccountId } from "@/lib/payments/recovery";
import { getStripe } from "@/lib/payments/stripe";
import { serviceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/database.types";
import { adminRange } from "./pagination";
import { provisionTradeCustomer } from "./trade-customer";

type FinanceCreditFunction = "begin_trade_account_approval" | "review_admin_trade_application" |
  "set_credit_limit" | "suspend_trade_account" | "reinstate_trade_account";

export async function financeCreditRpc<Name extends FinanceCreditFunction>(
  name: Name,
  args: Database["public"]["Functions"][Name]["Args"],
) {
  const { data, error } = await serviceClient().rpc(name, args);
  if (error) throw error;
  if (data === null) throw new Error("The credit operation returned no result.");
  return data;
}

export async function approveTradeApplication(applicationId: string, actorId: string, creditLimitPence: number) {
  const args = { p_application_id: applicationId, p_actor_id: actorId };
  const existing = await serviceClient().from("trade_accounts")
    .select("stripe_customer_id").eq("application_id", applicationId).maybeSingle();
  if (existing.error) throw existing.error;
  let customerId = existing.data?.stripe_customer_id;
  if (!customerId) {
    const stripe = getStripe();
    const application = await financeCreditRpc("begin_trade_account_approval", {
      ...args, p_stripe_account_id: await stripeAccountId(stripe),
    });
    customerId = await provisionTradeCustomer(stripe, application);
  }
  await financeCreditRpc("review_admin_trade_application", {
    ...args,
    p_decision: "approved",
    p_credit_limit_pence: creditLimitPence,
    p_stripe_customer_id: customerId,
  });
}

export async function adminTradeApplication(id: string) {
  const db = serviceClient();
  const [application, account] = await Promise.all([
    db.from("trade_applications").select(
      "id,company,buyer_name,buyer_id,email,billing_line1,billing_line2,billing_town,billing_postcode,status,created_at,reviewed_at,rejection_reason,approval_started_at",
    ).eq("id", id).maybeSingle(),
    db.from("trade_accounts").select("id").eq("application_id", id).maybeSingle(),
  ]);
  if (application.error || account.error) throw new Error("Could not load this trade application.");
  return application.data ? { application: application.data, accountId: account.data?.id } : null;
}

export async function adminTradeAccount(id: string, invoicesPage: number) {
  const db = serviceClient();
  const [account, position, invoices] = await Promise.all([
    db.from("trade_accounts").select("id,buyer_id,buyer_name,status,trade_applications(id,company,email)")
      .eq("id", id).maybeSingle(),
    db.from("trade_credit_position").select("credit_limit_pence,held_pence,outstanding_pence,available_credit_pence")
      .eq("trade_account_id", id).maybeSingle(),
    db.from("invoices").select(
      "order_id,provider_invoice_id,po_number,amount_due_pence,amount_remaining_pence,issued_at,due_at,status",
    ).eq("trade_account_id", id).order("due_at", { ascending: false }).order("order_id").range(...adminRange(invoicesPage)),
  ]);
  if (account.error || position.error || invoices.error) throw new Error("Could not load this trade account.");
  if (!account.data || !position.data) return null;
  const { credit_limit_pence, held_pence, outstanding_pence, available_credit_pence } = position.data;
  if (held_pence === null || outstanding_pence === null || available_credit_pence === null) {
    throw new Error("The trade credit position is incomplete.");
  }
  return {
    account: account.data, invoices: invoices.data,
    position: { credit_limit_pence, held_pence, outstanding_pence, available_credit_pence },
  };
}
