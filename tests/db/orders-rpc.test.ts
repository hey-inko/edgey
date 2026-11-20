import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, test, vi } from "vitest";
import { markProviderEvent, recordProviderEvent } from "@/lib/orders";

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
