"use server";

import { revalidatePath } from "next/cache";
import type { AdminResult } from "../form";
import { requireStaff } from "@/lib/admin/auth";
import { requestFinanceReplay, type FinanceReplayTarget } from "@/lib/admin/replay";

export async function retryFinanceFailure(target: FinanceReplayTarget): Promise<AdminResult> {
  const { userId } = await requireStaff("finance");
  if (!target || typeof target.id !== "string" ||
    !(target.kind === "event" ? /^evt_[A-Za-z0-9_]{1,196}$/.test(target.id) :
      target.kind === "confirmation" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(target.id))) {
    return { ok: false, message: "This retry does not refer to a valid item." };
  }

  try {
    if (!await requestFinanceReplay(userId, target)) {
      return { ok: false, message: "This item is no longer eligible for retry. Reload to check its current status." };
    }
    revalidatePath("/admin/finance");
    return { ok: true, message: "Retry requested. Processing is not connected yet." };
  } catch {
    return { ok: false, message: "Could not retry this item. Check the queue before trying again." };
  }
}
