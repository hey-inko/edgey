import "server-only";

import { cookies } from "next/headers";
import { commercialDb } from "./database";
import { finderCookie } from "./finder-cookie";
import { finderAttributionAllowed } from "./privacy";

export async function attributeFinderCheckout(orderId: string, attemptToken: string, buyerId: string | null) {
  try {
    if (!await finderAttributionAllowed()) return;
    const eventId = (await cookies()).get(finderCookie)?.value;
    if (!eventId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)) return;
    const { error } = await commercialDb().rpc("link_finder_checkout", {
      p_event_id: eventId, p_order_id: orderId, p_attempt_token: attemptToken, p_buyer_id: buyerId ?? undefined,
    }).abortSignal(AbortSignal.timeout(1_000));
    if (error) console.error("Finder checkout attribution could not be recorded.");
  } catch {
    return;
  }
}
