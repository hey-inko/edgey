import { expect, test } from "vitest";
import { ENGLAND_WALES_BANK_HOLIDAY_CALENDAR_2026_2027, STANDARD_DELIVERY_QUOTE } from "@/lib/commerce";
import { promiseForReservedOrder } from "@/lib/delivery/terms";

const authorisedAt = "2026-07-17T14:29:00Z";
const standard = "Next working day";
const calendar = ENGLAND_WALES_BANK_HOLIDAY_CALENDAR_2026_2027;
const snapshot = {
  version: 1,
  quote: STANDARD_DELIVERY_QUOTE,
  warehouseCalendar: { ...calendar, closures: ["2026-07-20"] },
  deliveryCalendar: { ...calendar, closures: ["2026-07-22"] },
  cutoffMinutes: 900,
};

test("only a legacy null standard snapshot uses the historical policy", () => {
  expect(promiseForReservedOrder({ delivery_service: standard, delivery_terms: null }, authorisedAt))
    .toEqual({ dispatchDate: "2026-07-17", deliveryDate: "2026-07-20" });
  expect(promiseForReservedOrder({ delivery_service: "Agreed service", delivery_terms: null }, authorisedAt)).toBeNull();
});

test("version one uses its saved cut-off and calendars", () => {
  expect(promiseForReservedOrder({ delivery_service: standard, delivery_terms: snapshot }, authorisedAt))
    .toEqual({ dispatchDate: "2026-07-21", deliveryDate: "2026-07-23" });
});

test.each([
  ["missing snapshot", undefined],
  ["missing version", { ...snapshot, version: undefined }],
  ["unknown version", { ...snapshot, version: 2 }],
  ["invalid cut-off", { ...snapshot, cutoffMinutes: 1440 }],
  ["invalid calendar", { ...snapshot, warehouseCalendar: { ...calendar, closures: ["2026-02-30"] } }],
  ["inconsistent service", { ...snapshot, quote: { ...STANDARD_DELIVERY_QUOTE, serviceName: "Changed" } }],
])("doesn't fall back to historical policy for a non-null %s", (_, delivery_terms) => {
  expect(promiseForReservedOrder({ delivery_service: standard, delivery_terms }, authorisedAt)).toBeNull();
});
