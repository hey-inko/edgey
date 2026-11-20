import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, test, vi } from "vitest";
import {
  createOrderWithReservations,
  markProviderEvent,
  recordProviderEvent,
} from "@/lib/orders";

vi.mock("server-only", () => ({}));

test("the server wrapper calls local PostgREST and returns a typed event row", async () => {
  const connectionString = process.env.SUPABASE_DB_URL;
  const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (
    !connectionString ||
    !apiUrl ||
    ![connectionString, apiUrl].every((url) =>
      ["127.0.0.1", "localhost"].includes(new URL(url).hostname),
    )
  ) {
    throw new Error(
      "These tests need the local Supabase stack. Run pnpm db:start && pnpm db:env.",
    );
  }

  const db = new Client({ connectionString });
  const eventId = randomUUID();
  const identity = { provider: "test", eventId };
  await db.connect();
  try {
    const event = await recordProviderEvent({
      ...identity,
      eventType: "checkout.completed",
      payload: { amount: 100 },
    });
    expect(event.event_id).toBe(eventId);
    expect(event.state).toBe("received");
    const processed = await markProviderEvent({
      ...identity,
      state: "processed",
    });
    expect(processed.state).toBe("processed");
    expect(
      await recordProviderEvent({
        ...identity,
        eventType: "checkout.completed",
        payload: {},
      }),
    ).toEqual(processed);
    const { rows } = await db.query<{ id: string; price_1_4_pence: number }>(
      "select id, price_1_4_pence from public.variants where sku = 'EDG-SUM-DRG-60'",
    );
    const soldOut = rows[0]!;
    const net = soldOut.price_1_4_pence;
    const tax = Math.round(net * 0.2);
    await expect(
      createOrderWithReservations({
        attemptToken: randomUUID(),
        lines: [{ variantId: soldOut.id, quantity: 1, unitPricePence: net }],
        contact: {
          email: "guest@example.test",
          businessName: "Test Fabrication",
          recipientName: "Test Buyer",
          buyingForWork: true,
        },
        address: {
          line1: "1 Test Street",
          town: "London",
          postcode: "SW1A 1AA",
          country: "GB",
        },
        totals: {
          goodsNetPence: net,
          deliveryNetPence: 0,
          vatRateBps: 2000,
          vatPence: tax,
          grossPence: net + tax,
        },
        holdExpiresAt: new Date(Date.now() + 31 * 60 * 1000).toISOString(),
        deliveryService: "Standard",
        promise: { dispatchDate: "2099-01-06", deliveryDate: "2099-01-07" },
      }),
    ).rejects.toMatchObject({
      code: "P0001",
      message: "insufficient_stock",
      details: soldOut.id,
    });
  } finally {
    try {
      await db.query(
        "delete from public.provider_events where provider = $1 and event_id = $2",
        [identity.provider, eventId],
      );
    } finally {
      await db.end();
    }
  }
});
