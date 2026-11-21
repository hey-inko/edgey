import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

const id = (prefix) => prefix + randomBytes(12).toString("hex");

export async function startStripeApi() {
  const sessions = new Map();
  const requests = new Map();
  const intents = new Map();
  const invoices = new Map();
  let dropNextCreate = false;
  const server = createServer(async (req, res) => {
    const reply = (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const fail = (message, status = 400) => reply({ error: { type: "invalid_request_error", message } }, status);
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname.split("/").slice(1);
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      const payload = Buffer.concat(parts).toString();
      const get = req.method === "GET";
      const post = req.method === "POST";
      if (path[0] === "fixture") {
        if (path[1] === "sessions" && get) return reply({ sessions: [...sessions.values()], requests: [...requests.values()] });
        if (path[1] === "drop-next-create" && post) {
          dropNextCreate = true;
          return reply({ armed: true });
        }
        const session = sessions.get(path[2]);
        if (!session) return fail("Unknown test Checkout Session.", 404);
        if (path[1] === "capture" && post && session.status === "open") {
          const { created } = JSON.parse(payload);
          const intent = {
            id: id("pi_"), object: "payment_intent", livemode: false, status: "succeeded",
            metadata: session.metadata, amount_received: session.amount_total, currency: session.currency,
          };
          intent.latest_charge = {
            id: id("ch_"), object: "charge", payment_intent: intent.id, livemode: false,
            paid: true, captured: true, currency: intent.currency, amount_captured: intent.amount_received, created,
          };
          const invoice = {
            id: id("in_"), object: "invoice", livemode: false, status: "paid",
            metadata: session.metadata, currency: session.currency, total: session.amount_total,
            footer: session.invoice_footer, hosted_invoice_url: `https://invoice.stripe.com/i/${id("invst_")}`,
            lines: { data: session.lines.map(({ amount, quantity, description }) => ({
              amount: amount * quantity, quantity, description,
            })) },
          };
          intents.set(intent.id, intent);
          invoices.set(invoice.id, invoice);
          Object.assign(session, {
            status: "complete", payment_status: "paid", payment_intent: intent.id, invoice: invoice.id,
          });
          return reply(invoice);
        }
        if (path[1] === "expire" && post && session.status === "open") {
          session.status = "expired";
          return reply(session);
        }
        return fail("Unknown fixture action.");
      }
      if (path[0] !== "v1" || !req.headers.authorization?.startsWith("Bearer sk_test_") ||
        req.headers["stripe-version"] !== "2026-11-18.endive") {
        return fail("Expected the pinned Stripe test API contract.");
      }
      if (path[1] === "account" && path.length === 2 && get) {
        return reply({ id: "acct_edgeyAcceptance", object: "account" });
      }
      if (path[1] === "checkout" && path[2] === "sessions") {
        if (path.length === 3 && get) {
          const payment = url.searchParams.get("payment_intent");
          const from = Number(url.searchParams.get("created[gte]") ?? 0);
          const until = Number(url.searchParams.get("created[lte]") ?? Number.MAX_SAFE_INTEGER);
          return reply({ object: "list", has_more: false, data: [...sessions.values()].filter((session) =>
            payment ? session.payment_intent === payment : session.created >= from && session.created <= until) });
        }
        if (path.length === 3 && post) {
          const key = req.headers["idempotency-key"];
          if (!key) return fail("An idempotency key is required.");
          const existing = requests.get(key);
          if (existing) {
            existing.count++;
            if (existing.body !== payload) return fail("An idempotency key was reused with a different payload.", 409);
            return reply(sessions.get(existing.sessionId));
          }
          const form = new URLSearchParams(payload);
          const lines = [];
          for (let i = 0; form.has(`line_items[${i}][quantity]`); i++) {
            const prefix = `line_items[${i}]`;
            lines.push({
              quantity: Number(form.get(`${prefix}[quantity]`)),
              currency: form.get(`${prefix}[price_data][currency]`),
              amount: Number(form.get(`${prefix}[price_data][unit_amount]`)),
              name: form.get(`${prefix}[price_data][product_data][name]`),
              description: form.get(`${prefix}[price_data][product_data][description]`),
            });
          }
          if (!lines.length || lines.some(({ currency, amount, quantity }) =>
            currency !== "gbp" || !Number.isSafeInteger(amount) || amount < 0 || !(quantity > 0))) {
            return fail("Invalid Checkout line items.");
          }
          const sessionId = id("cs_test_");
          const session = {
            id: sessionId, object: "checkout.session", livemode: false, mode: form.get("mode"),
            metadata: { edgey_order_id: form.get("metadata[edgey_order_id]") },
            client_reference_id: form.get("client_reference_id"), expires_at: Number(form.get("expires_at")),
            status: "open", payment_status: "unpaid", currency: "gbp",
            amount_total: lines.reduce((sum, line) => sum + line.amount * line.quantity, 0),
            created: Math.floor(Date.now() / 1000), payment_intent: null, invoice: null,
            success_url: form.get("success_url"), url: `https://checkout.stripe.com/c/pay/${sessionId}`,
            invoice_footer: form.get("invoice_creation[invoice_data][footer]"), lines,
          };
          requests.set(key, { key, sessionId, body: payload, count: 1 });
          sessions.set(sessionId, session);
          if (dropNextCreate) {
            dropNextCreate = false;
            return req.socket.destroy();
          }
          return reply(session);
        }
        const session = sessions.get(path[3]);
        if (session && get && path.length === 4) return reply(session);
        if (session && post && path[4] === "expire" && session.status === "open") {
          session.status = "expired";
          return reply(session);
        }
      }
      if (get && path[1] === "payment_intents" && intents.has(path[2])) return reply(intents.get(path[2]));
      if (get && path[1] === "invoices" && invoices.has(path[2])) return reply(invoices.get(path[2]));
      return fail("No matching Stripe API fixture: " + req.method + " " + url.pathname, 404);
    } catch {
      return fail("Could not handle Stripe API fixture.", 500);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
