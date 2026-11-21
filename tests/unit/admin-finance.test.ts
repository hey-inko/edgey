import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { parseCreditLimit } from "@/lib/admin/credit-limit";
import { amountMismatch, resolveCardMismatchRefund, verifyMismatchRefund } from "@/lib/admin/payment-review";
import { provisionTradeCustomer } from "@/lib/admin/trade-customer";
import { resolveRefundedPaymentReview } from "@/lib/orders";
import { getOrder, type Order } from "@/lib/payments/store";
import { getStripe } from "@/lib/payments/stripe";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/orders", () => ({ resolveRefundedPaymentReview: vi.fn() }));
vi.mock("@/lib/payments/store", () => ({ getOrder: vi.fn() }));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: vi.fn() }));

const id = "39d0d90e-b334-4cfa-988a-99bd09ff47f1";
const now = Date.parse("2026-11-21T08:00:00Z");
const application = {
  id, approval_started_at: new Date(now - 60_000).toISOString(), company: "Fixture Ltd",
  email: "fixture@example.test", billing_line1: "1 Fixture Lane", billing_line2: null,
  billing_town: "London", billing_postcode: "SW1A 1AA",
};
const customer = {
  id: "cus_Fixture1", livemode: false, name: application.company, email: application.email,
  address: { line1: "1 Fixture Lane", line2: null, city: "London", postal_code: "SW1A 1AA", country: "GB" },
  metadata: { edgey_trade_application_id: id },
};

function stripeCustomers(matches: unknown[] = [], record: unknown = customer) {
  const search = vi.fn().mockResolvedValue({ has_more: false, data: matches });
  const retrieve = vi.fn().mockResolvedValue(record);
  const create = vi.fn().mockResolvedValue(record);
  return { stripe: { customers: { search, create, retrieve } } as unknown as Stripe, search, retrieve, create };
}

describe("finance limits", () => {
  it.each([["0", 0], [" 120.4 ", 12040], ["120.04", 12004], ["21474836.47", 2147483647]])("parses %s without floating point rounding", (input, amount) => {
    expect(parseCreditLimit(input)).toBe(amount);
  });

  it.each(["", "-1", "£2", "1e2", "10,000", "1.001", "21474836.48"])("rejects %s", (input) => {
    expect(parseCreditLimit(input)).toBeNull();
  });
});

describe("Stripe customer provisioning", () => {
  it("uses stored billing fields and reuses the application key after an ambiguous create", async () => {
    const { stripe, search, create } = stripeCustomers();
    create.mockRejectedValueOnce(new Error("Connection closed"));
    await expect(provisionTradeCustomer(stripe, application, now)).rejects.toThrow("Connection closed");
    await expect(provisionTradeCustomer(stripe, application, now + 30_000)).resolves.toBe(customer.id);
    expect(search).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: customer.name, email: customer.email, metadata: customer.metadata,
      address: expect.objectContaining({ line1: customer.address.line1, country: "GB" }),
    }), { idempotencyKey: `edgey-trade-customer:${id}` });
  });

  it("recovers a canonical existing customer beyond retention without creating another", async () => {
    const { stripe, retrieve, create } = stripeCustomers([customer]);
    await expect(provisionTradeCustomer(stripe, application, now + 25 * 60 * 60_000)).resolves.toBe(customer.id);
    expect(retrieve).toHaveBeenCalledWith(customer.id);
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed on an old missing customer, duplicates, a deleted customer, or incorrect billing", async () => {
    const missing = stripeCustomers();
    await expect(provisionTradeCustomer(missing.stripe, application, now + 25 * 60 * 60_000)).rejects.toThrow("too late");
    expect(missing.create).not.toHaveBeenCalled();
    for (const fixture of [
      stripeCustomers([customer, customer]),
      stripeCustomers([customer], { id: customer.id, deleted: true }),
      stripeCustomers([customer], { ...customer, email: "unrelated@example.test" }),
    ]) {
      await expect(provisionTradeCustomer(fixture.stripe, application, now)).rejects.toThrow();
      expect(fixture.create).not.toHaveBeenCalled();
    }
  });
});

const order = {
  id, gross_pence: 12000, paid_pence: 0, currency: "GBP", fulfilment_status: "awaiting_authorisation",
  payment_method: "card", payment_review_reason: amountMismatch, checkout_session_id: "cs_test_Fixture1",
  payment_intent_id: "pi_Fixture1", hold_expires_at: "2026-11-21T10:00:00Z",
} as Order;
const capture = {
  id: "ch_Fixture1", amount_captured: 12010, amount_refunded: 12010, currency: "gbp", livemode: false,
  paid: true, captured: true, refunded: true, payment_intent: order.payment_intent_id,
};
const refund = {
  id: "re_Fixture1", amount: 12010, currency: "gbp", status: "succeeded", charge: capture.id,
  payment_intent: order.payment_intent_id,
};

function stripeRefunds(refunds: unknown[] = [refund], charge = capture) {
  const sessions = vi.fn().mockResolvedValue({
    id: order.checkout_session_id, livemode: false, mode: "payment", metadata: { edgey_order_id: id },
    client_reference_id: id, expires_at: Date.parse(order.hold_expires_at) / 1_000, payment_intent: order.payment_intent_id,
  });
  const intents = vi.fn().mockResolvedValue({
    id: order.payment_intent_id, livemode: false, status: "succeeded", currency: charge.currency,
    amount_received: charge.amount_captured, latest_charge: charge, metadata: { edgey_order_id: id },
  });
  const list = vi.fn().mockReturnValue(refunds);
  return {
    stripe: { checkout: { sessions: { retrieve: sessions } }, paymentIntents: { retrieve: intents },
      refunds: { list } } as unknown as Stripe,
    sessions, intents, list,
  };
}

describe("full card mismatch refund", () => {
  it("verifies the payment identity and totals succeeded refunds independent of their ordering", async () => {
    const second = { ...refund, amount: 5010, id: "re_Fixture2" };
    const first = { ...refund, amount: 7000 };
    for (const refunds of [[first, second], [second, first]]) {
      const { stripe, list } = stripeRefunds(refunds);
      await expect(verifyMismatchRefund(stripe, order)).resolves.toEqual({
        paymentIntentId: order.payment_intent_id, refundId: second.id,
      });
      expect(list).toHaveBeenCalledWith({ charge: capture.id, limit: 100 });
    }
  });

  it("doesn’t read Stripe for a Net 30 or already settled order", async () => {
    const { stripe, sessions } = stripeRefunds();
    await expect(verifyMismatchRefund(stripe, { ...order, payment_method: "net30" })).rejects.toThrow("matching card");
    await expect(verifyMismatchRefund(stripe, { ...order, paid_pence: 1 })).rejects.toThrow("matching card");
    expect(sessions).not.toHaveBeenCalled();
  });

  it("rejects a different checkout, partial refund, pending refund, or foreign refund", async () => {
    const unrelated = stripeRefunds();
    unrelated.sessions.mockResolvedValueOnce({ livemode: true });
    await expect(verifyMismatchRefund(unrelated.stripe, order)).rejects.toThrow("Checkout identity");
    const partial = stripeRefunds([refund], { ...capture, refunded: false, amount_refunded: 1 });
    await expect(verifyMismatchRefund(partial.stripe, order)).rejects.toThrow("hasn’t been fully refunded");
    await expect(verifyMismatchRefund(stripeRefunds([{ ...refund, status: "pending" }]).stripe, order)).rejects.toThrow("don’t yet cover");
    await expect(verifyMismatchRefund(stripeRefunds([{ ...refund, charge: "ch_Other" }]).stripe, order)).rejects.toThrow("don’t match");
  });

  it("passes only independently verified proof to the resolution RPC, and replays a completed review without Stripe", async () => {
    const actorId = "c33cb926-8a8c-4955-991e-cd736bade8c9";
    vi.mocked(getOrder).mockResolvedValue(order);
    vi.mocked(getStripe).mockReturnValueOnce(stripeRefunds([]).stripe)
      .mockReturnValueOnce(stripeRefunds().stripe);

    await expect(resolveCardMismatchRefund(id, actorId)).rejects.toThrow("don’t yet cover");
    expect(resolveRefundedPaymentReview).not.toHaveBeenCalled();
    await resolveCardMismatchRefund(id, actorId);
    expect(resolveRefundedPaymentReview).toHaveBeenCalledExactlyOnceWith({
      orderId: id, actorId, paymentIntentId: order.payment_intent_id, refundId: refund.id,
    });
    vi.mocked(getOrder).mockResolvedValueOnce({ ...order, payment_review_refund_id: refund.id });
    await resolveCardMismatchRefund(id, actorId);
    expect(getStripe).toHaveBeenCalledTimes(2);
    expect(resolveRefundedPaymentReview).toHaveBeenCalledTimes(1);
  });
});
