import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export async function startStripeFixture() {
  const token = randomBytes(12).toString("hex");
  const key = `sk_test_playwright_${token}`;
  const secret = `whsec_playwright_${token}`;
  const accountId = `acct_${token}`;
  const customerId = `cus_${token}`;
  const invoiceId = `in_${token}`;
  const invoiceUrl = `https://invoice.stripe.com/i/${accountId}/invst_playwright`;
  const calls: { path: string; method: string; params: URLSearchParams; key?: string }[] = [];
  const unexpected: string[] = [];
  const allocations: {
    id: string; invoice: string; amount_paid: number; currency: "gbp"; status: "paid";
    livemode: false; payment: { type: "payment_intent"; payment_intent: string };
  }[] = [];
  const issuedAt = Math.floor(Date.now() / 1000);
  let customer: Record<string, unknown> | undefined;
  let invoiceCreated = false;
  let loseSendResponse = false;
  const invoice = {
    id: invoiceId, object: "invoice", livemode: false, status: "draft",
    collection_method: "send_invoice", currency: "gbp", customer: customerId,
    metadata: {} as Record<string, string>,
    total: 0, total_excluding_tax: 0, total_taxes: [] as { amount: number }[],
    amount_due: 0, amount_paid: 0, amount_remaining: 0, starting_balance: 0,
    amount_overpaid: 0, pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
    created: issuedAt, due_date: null as number | null, hosted_invoice_url: null as string | null,
    status_transitions: { finalized_at: null as number | null },
    lines: { data: [] as { amount: number }[] },
  };
  const list = (path: string, data: unknown[] = []) => ({ object: "list", url: path, has_more: false, data });

  function respond(path: string, method: string, params: URLSearchParams) {
    const get = (name: string) => params.get(name) ?? undefined;
    switch (`${method} ${path}`) {
      case "GET /v1/account":
        return { object: "account", id: accountId };
      case "GET /v1/customers/search":
        return { object: "search_result", has_more: false, data: customer ? [customer] : [] };
      case "POST /v1/customers":
        if (customer) break;
        return customer = {
          id: customerId, object: "customer", livemode: false, name: get("name"), email: get("email"),
          address: {
            line1: get("address[line1]"), line2: get("address[line2]"), city: get("address[city]"),
            postal_code: get("address[postal_code]"), country: get("address[country]"),
          },
          metadata: { edgey_trade_application_id: get("metadata[edgey_trade_application_id]") },
        };
      case "GET /v1/invoices":
        if (get("customer") !== customerId) break;
        return list(path, invoiceCreated ? [invoice] : []);
      case "POST /v1/invoices":
        if (invoiceCreated || !customer || get("customer") !== customerId ||
          get("collection_method") !== "send_invoice" || get("days_until_due") !== "30" || get("currency") !== "gbp") break;
        invoiceCreated = true;
        for (const name of ["edgey_order_id", "edgey_payment_method", "po_number"]) {
          invoice.metadata[name] = get(`metadata[${name}]`) ?? "";
        }
        return invoice;
      case `POST /v1/invoices/${invoiceId}/add_lines`: {
        if (!invoiceCreated || invoice.lines.data.length || invoice.status !== "draft") break;
        for (let index = 0; params.has(`lines[${index}][amount]`); index++) {
          const line = `lines[${index}]`;
          const tax = `${line}[tax_amounts][0]`;
          const amount = Number(get(`${line}[amount]`));
          const vat = Number(get(`${tax}[amount]`));
          if (!Number.isInteger(amount) || !Number.isInteger(vat) ||
            get(`${tax}[tax_rate_data][inclusive]`) !== "false" ||
            get(`${tax}[taxable_amount]`) !== String(amount)) return;
          invoice.lines.data.push({ amount });
          invoice.total_taxes.push({ amount: vat });
          invoice.total_excluding_tax += amount;
          invoice.total += amount + vat;
        }
        invoice.metadata.edgey_lines_version = get("invoice_metadata[edgey_lines_version]") ?? "";
        invoice.amount_due = invoice.amount_remaining = invoice.total;
        return invoice;
      }
      case `POST /v1/invoices/${invoiceId}/finalize`:
        if (invoice.status !== "draft" || !invoice.lines.data.length) break;
        invoice.status = "open";
        invoice.status_transitions.finalized_at = issuedAt;
        invoice.due_date = issuedAt + 30 * 86_400;
        invoice.hosted_invoice_url = invoiceUrl;
        return invoice;
      case `POST /v1/invoices/${invoiceId}/send`:
        if (invoice.status === "open") return invoice;
        break;
      case `GET /v1/invoices/${invoiceId}`:
        if (invoiceCreated) return invoice;
        break;
      case "GET /v1/invoice_payments":
        if (get("invoice") === invoiceId && get("status") === "paid") return list(path, allocations);
        break;
      case "GET /v1/credit_notes":
        if (get("invoice") === invoiceId) return list(path);
        break;
      case "GET /v1/refunds":
        if (allocations.some(({ payment }) => payment.payment_intent === get("payment_intent"))) return list(path);
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const params = method === "GET" ? url.searchParams : new URLSearchParams(Buffer.concat(chunks).toString());
    const idempotencyKey = req.headers["idempotency-key"];
    calls.push({ path: url.pathname, method, params, key: typeof idempotencyKey === "string" ? idempotencyKey : undefined });
    if (loseSendResponse && req.headers.authorization === `Bearer ${key}` && invoice.status === "open" &&
      method === "POST" && url.pathname === `/v1/invoices/${invoiceId}/send`) {
      loseSendResponse = false;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Fixture did not return send evidence" } }));
      return;
    }
    const result = req.headers.authorization === `Bearer ${key}` && respond(url.pathname, method, params);
    if (!result) unexpected.push(`${method} ${url.pathname}`);
    res.writeHead(result ? 200 : 400, { "content-type": "application/json" });
    res.end(JSON.stringify(result || { error: { type: "invalid_request_error", message: "Unexpected Stripe fixture request" } }));
  });
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;

  return {
    port: (server.address() as AddressInfo).port, key, secret, invoiceId, invoiceUrl, calls, unexpected,
    dropNextSendResponse: () => { loseSendResponse = true; },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    pay(amount: number) {
      if (invoice.status !== "open" || !Number.isInteger(amount) || amount <= 0 || amount > invoice.amount_remaining) {
        throw new Error("Fixture payment must settle part or all of the open invoice.");
      }
      const sequence = allocations.length + 1;
      allocations.push({
        id: `inpay_${token}${sequence}`, invoice: invoiceId, amount_paid: amount, currency: "gbp",
        status: "paid", livemode: false, payment: { type: "payment_intent", payment_intent: `pi_${token}${sequence}` },
      });
      invoice.amount_paid += amount;
      invoice.amount_remaining -= amount;
      if (invoice.amount_remaining === 0) invoice.status = "paid";
    },
    webhook(type: string, id: string) {
      const timestamp = Math.floor(Date.now() / 1000);
      const body = Buffer.from(JSON.stringify({
        id, object: "event", type, livemode: false, created: timestamp,
        data: { object: { id: invoiceId, object: "invoice" } },
      }, null, 2) + "\n");
      const signature = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
      return { body, signature: `t=${timestamp},v1=${signature}` };
    },
  };
}
