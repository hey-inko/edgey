import "server-only";

import { replayStripeEvent } from "@/lib/payments/reconciliation";
import { replayOrderConfirmation } from "@/lib/email/outbox";

export type FinanceReplayTarget = { kind: "event" | "confirmation"; id: string };

export async function replayFinanceFailure(target: FinanceReplayTarget) {
  return target.kind === "event" ? replayStripeEvent(target.id) : replayOrderConfirmation(target.id);
}
