"use server";

import { revalidatePath } from "next/cache";
import type { AdminResult } from "../form";
import { requireStaff } from "@/lib/admin/auth";
import { resolveCardMismatchRefund } from "@/lib/admin/payment-review";
import { requestFinanceReplay, type FinanceReplayTarget } from "@/lib/admin/replay";
import { isWarehouseId } from "@/lib/admin/warehouse-format";
import { refundCancelledCardOrder } from "@/lib/payments/card-refund";
import { resolveCancelledNet30Invoice, voidCancelledNet30Invoice } from "@/lib/payments/net30";
import { PaymentReviewError } from "@/lib/payments/session-identity";

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
    return { ok: true, message: "Retry queued." };
  } catch {
    return { ok: false, message: "Could not retry this item. Check the queue before trying again." };
  }
}

export async function resolveFinancePaymentReview(orderId: string): Promise<AdminResult> {
  const { userId } = await requireStaff("finance");
  if (!isWarehouseId(orderId)) return { ok: false, message: "This is not a valid order reference." };
  try {
    await resolveCardMismatchRefund(orderId, userId);
  } catch (error) {
    return { ok: false, message: error instanceof PaymentReviewError ? error.message
      : "Could not confirm the Stripe refund or close the review. Reload and check the order before retrying." };
  }
  for (const path of ["/admin/finance", "/admin/stock", `/admin/warehouse/${orderId}`, "/", "/blades"]) revalidatePath(path);
  revalidatePath("/blades/[slug]", "page");
  revalidatePath("/admin/stock/[id]", "page");
  return { ok: true, message: "Full refund verified. The payment review is closed." };
}

export async function refundFinanceCard(
  orderId: string, allowCreate: boolean, _previous: AdminResult | null, form: FormData,
): Promise<AdminResult> {
  const { userId } = await requireStaff("finance");
  if (!isWarehouseId(orderId)) return { ok: false, message: "This is not a valid order reference." };
  if (allowCreate && form.get("confirm") !== "yes") {
    return { ok: false, message: "Confirm that you want to refund the remaining capture." };
  }
  try {
    const outcome = await refundCancelledCardOrder(orderId, userId, allowCreate);
    revalidatePath("/admin/finance");
    return { ok: true, message: outcome === "refunded" ? "Full refund verified. No stock was changed."
      : "The refund hasn’t settled yet. Check it again before making any adjustment in Stripe." };
  } catch (error) {
    return { ok: false, message: error instanceof PaymentReviewError ? error.message
      : "Could not confirm the refund. Retry here to check Stripe before sending another refund." };
  }
}

export async function reconcileFinanceInvoice(
  orderId: string, voidIfUnpaid: boolean, _previous: AdminResult | null, form: FormData,
): Promise<AdminResult> {
  const { userId } = await requireStaff("finance");
  if (!isWarehouseId(orderId)) return { ok: false, message: "This is not a valid order reference." };
  if (voidIfUnpaid && form.get("confirm") !== "yes") {
    return { ok: false, message: "Confirm that you are allowed to void this invoice." };
  }
  let outcome;
  try {
    outcome = voidIfUnpaid ? await voidCancelledNet30Invoice(orderId, userId) : await resolveCancelledNet30Invoice(orderId, userId);
  } catch (error) {
    return { ok: false, message: error instanceof PaymentReviewError ? error.message
      : "Could not confirm the invoice adjustment. Check Stripe and retry verification." };
  }
  for (const path of ["/admin/finance", `/admin/warehouse/${orderId}`, "/account"]) revalidatePath(path);
  revalidatePath("/admin/finance/accounts/[id]", "page");
  if (outcome === "unresolved") return {
    ok: false, message: "The invoice still has a balance or unrefunded payment. Check Stripe for the required credit note or refund.",
  };
  return { ok: true, message: outcome === "voided" ? "Invoice voided. Outstanding credit has been released."
    : "Stripe adjustments verified. No balance or captured payment remains." };
}
