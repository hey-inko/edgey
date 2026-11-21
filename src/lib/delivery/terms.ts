import { z } from "zod";
import {
  calculateDispatchPromise, STANDARD_DELIVERY_QUOTE,
  type CoverageError, type CommerceResult, type UkPostcode,
} from "@/lib/commerce";
import { isValidDeliveryQuote } from "@/lib/commerce/delivery";

const calendarSchema = z.object({
  workingWeekdays: z.array(z.literal([0, 1, 2, 3, 4, 5, 6])).min(1).max(7),
  bankHolidays: z.array(z.iso.date()),
  closures: z.array(z.iso.date()),
  dateRange: z.object({ from: z.iso.date(), through: z.iso.date() }),
});

export const warehouseScheduleSchema = z.object({
  warehouseCalendar: calendarSchema,
  cutoffMinutes: z.int().min(0).max(1439),
});

const quoteFields = { serviceName: z.string().trim().min(1).max(100), chargeExVatPence: z.int().nonnegative() };
const deliveryTermsSchema = warehouseScheduleSchema.extend({
  version: z.literal(1),
  quote: z.discriminatedUnion("kind", [
    z.object({ ...quoteFields, kind: z.literal("next-working-day"), workingDays: z.literal(1) }),
    z.object({ ...quoteFields, kind: z.literal("agreed"), workingDays: z.int().min(2).max(366) }),
  ]).refine(isValidDeliveryQuote),
  deliveryCalendar: calendarSchema,
});

export type WarehouseSchedule = z.infer<typeof warehouseScheduleSchema>;
export type DeliveryTerms = z.infer<typeof deliveryTermsSchema>;
export type DeliveryResolution = CommerceResult<{ postcode: UkPostcode; terms: DeliveryTerms | null }, CoverageError>;

export function parseDeliveryTerms(snapshot: unknown): DeliveryTerms | null {
  return deliveryTermsSchema.safeParse(snapshot).data ?? null;
}

export function promiseUnderTerms(authorisedAt: string, terms: DeliveryTerms) {
  return calculateDispatchPromise({
    authorisedAt,
    deliveryQuote: terms.quote,
    warehouseCalendar: terms.warehouseCalendar,
    deliveryCalendar: terms.deliveryCalendar,
    cutoffMinutes: terms.cutoffMinutes,
  });
}

export function promiseForReservedOrder(
  order: { delivery_service: string; delivery_terms: unknown },
  authorisedAt: string,
): { dispatchDate: string; deliveryDate: string } | null {
  const snapshot = parseDeliveryTerms(order.delivery_terms);
  const promise = snapshot?.quote.serviceName === order.delivery_service
    ? promiseUnderTerms(authorisedAt, snapshot)
    : order.delivery_terms === null && order.delivery_service === STANDARD_DELIVERY_QUOTE.serviceName
      ? calculateDispatchPromise({ authorisedAt, deliveryQuote: STANDARD_DELIVERY_QUOTE })
      : null;
  return promise?.ok && promise.value.estimatedDeliveryDate
    ? { dispatchDate: promise.value.dispatchDate, deliveryDate: promise.value.estimatedDeliveryDate }
    : null;
}
