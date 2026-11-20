"use server";

import type { AdminResult } from "../form";
import { requireStaff } from "@/lib/admin/auth";
import { replayFinanceFailure, type FinanceReplayTarget } from "@/lib/admin/replay";

export async function retryFinanceFailure(target: FinanceReplayTarget): Promise<AdminResult> {
  await requireStaff("finance");
  if (!target || typeof target.id !== "string" ||
    !(target.kind === "event" ? /^evt_[A-Za-z0-9_]{1,196}$/.test(target.id) :
      target.kind === "confirmation" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(target.id))) {
    return { ok: false, message: "This retry does not refer to a valid item." };
  }

  try {
    const state = await replayFinanceFailure(target);
    if (state === "processed") return { ok: true, message: "Event processed. Reload to update the queue." };
    if (state === "sent") return { ok: true, message: "Confirmation sent. Reload to update the queue." };
    if (state === "pending") return { ok: true, message: "Confirmation is pending. Check the queue again later." };
    if (state === "not_replayable") return { ok: false, message: "This item is no longer eligible for retry. Reload to check its current status." };
    return { ok: false, message: "The retry failed. Reload to see the latest status." };
  } catch {
    return { ok: false, message: "Could not retry this item. Check the queue before trying again." };
  }
}
