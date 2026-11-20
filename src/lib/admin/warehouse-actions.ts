"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/admin/auth";
import {
  cancelOrder, dispatchOrder, receiveStock, recordReturn, restoreStock, startPicking,
} from "@/lib/orders";
import { isWarehouseId } from "./warehouse-format";

type State = { message: string; ok: boolean } | null;
type WarehouseAction =
  | { kind: "pick" | "dispatch" | "cancel" | "return"; orderId: string; key: string }
  | { kind: "restore"; orderId: string; returnId: string; key: string }
  | { kind: "receive"; variantId: string; key: string };

const errors: Readonly<Record<string, string>> = {
  carrier_and_tracking_required: "Enter both the carrier and tracking number.",
  invalid_stock_receipt: "Enter a positive whole number of units.",
  operation_key_conflict: "This form was already used with different values. Reload the page before starting a new operation.",
  order_cannot_be_cancelled: "This order can no longer be cancelled. Reload to check its current status.",
  order_not_dispatched: "Record a return only after the order has been dispatched.",
  order_not_found: "This order could not be found.",
  order_not_picking: "Start picking before dispatching. If you already did, reload to check the current status.",
  order_not_ready_to_pick: "This order is no longer ready to pick. Reload to check its current status.",
  order_payment_not_collectible: "A voided or fully refunded order cannot be picked or dispatched.",
  restore_exceeds_returned_quantity: "You can only restore units from this return that have not already been restored.",
  return_exceeds_dispatched_quantity: "The quantity is greater than the outstanding dispatched units on this line.",
  return_not_found: "This return could not be found.",
  warehouse_role_required: "You no longer have warehouse access.",
};

function text(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function refused(message: string) {
  return { ok: false, message };
}

export async function runWarehouseAction(action: WarehouseAction, _previous: State, form: FormData) {
  const { userId: actorId } = await requireStaff("warehouse");
  if (!isWarehouseId(action.key) || (
    action.kind === "receive" ? !isWarehouseId(action.variantId) : !isWarehouseId(action.orderId)
  )) {
    return refused("This form is no longer valid. Reload the page and try again.");
  }

  const units = text(form, "quantity");
  const quantity = /^\d{1,10}$/.test(units) ? Number(units) : 0;
  if ((action.kind === "receive" || action.kind === "return" || action.kind === "restore") &&
    (quantity < 1 || quantity > 2_147_483_647)) {
    return refused("Enter a positive whole number of units.");
  }

  const operationKey = action.key;
  let message: string;
  let affectedVariant: string | undefined;

  try {
    switch (action.kind) {
      case "pick": {
        const updated = await startPicking({ orderId: action.orderId, actorId, operationKey });
        message = updated.fulfilment_status === "picking"
          ? "Picking started." : "The order has since moved on from picking.";
        break;
      }
      case "dispatch": {
        const carrier = text(form, "carrier");
        const trackingNumber = text(form, "trackingNumber");
        if (!carrier || carrier.length > 100 || !trackingNumber || trackingNumber.length > 200) {
          return refused("Enter a carrier (up to 100 characters) and tracking number (up to 200 characters).");
        }
        await dispatchOrder({ orderId: action.orderId, actorId, operationKey, carrier, trackingNumber });
        message = "Dispatch recorded.";
        break;
      }
      case "cancel":
        if (text(form, "confirmCancel") !== "yes") return refused("Confirm cancellation before continuing.");
        await cancelOrder({ orderId: action.orderId, actorId, operationKey });
        message = "Order cancelled and allocation released. Any refund is handled separately by finance.";
        break;
      case "return": {
        const variantId = text(form, "variantId");
        const reason = text(form, "reason");
        const lookupCode = text(form, "lookupCode");
        if (!isWarehouseId(variantId)) return refused("Select a dispatched line.");
        if (!reason || reason.length > 500) return refused("Enter a return reason of up to 500 characters.");
        if (lookupCode.length > 100) return refused("Enter a lookup code of up to 100 characters.");
        await recordReturn({
          orderId: action.orderId, actorId, returnId: operationKey, variantId, quantity, reason,
          lookupCode: lookupCode || undefined,
        });
        message = "Return recorded. No units have been added to saleable stock.";
        break;
      }
      case "restore":
        if (!isWarehouseId(action.returnId)) return refused("This return could not be found.");
        affectedVariant = (await restoreStock({ returnId: action.returnId, actorId, operationKey, quantity })).variant_id;
        message = "Inspected units restored to saleable stock.";
        break;
      case "receive":
        await receiveStock({ variantId: action.variantId, actorId, operationKey, quantity });
        affectedVariant = action.variantId;
        message = "Stock receipt recorded.";
        break;
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "message" in error &&
      typeof error.message === "string" && Object.hasOwn(errors, error.message)) {
      return refused(errors[error.message] ?? "The warehouse operation was refused.");
    }
    return refused("The update could not be confirmed. Try again with the same values.");
  }

  if (action.kind !== "receive") {
    revalidatePath("/admin/warehouse");
    revalidatePath(`/admin/warehouse/${action.orderId}`);
  }
  if (affectedVariant || action.kind === "dispatch" || action.kind === "cancel") {
    revalidatePath("/admin/stock");
    revalidatePath(affectedVariant ? `/admin/stock/${affectedVariant}` : "/admin/stock/[id]", affectedVariant ? undefined : "page");
  }
  return { ok: true, message };
}
