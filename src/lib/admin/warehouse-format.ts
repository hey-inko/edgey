export const warehousePageSize = 50;

export function warehousePage(value: unknown) {
  const page = typeof value === "string" && /^\d{1,6}$/.test(value) ? Number(value) : 1;
  return Math.max(1, page);
}

export function isWarehouseId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}

export type WarehouseOrderLookup = { field: "id" | "order_reference"; value: string };

export function warehouseOrderLookup(value: string): WarehouseOrderLookup | null {
  if (/^EDG-[0-9]{8}$/i.test(value)) return { field: "order_reference", value: value.toUpperCase() };
  return isWarehouseId(value) ? { field: "id", value } : null;
}

const calendarDate = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const warehouseTime = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/London",
});

export function dispatchDate(date: string) {
  return calendarDate.format(new Date(date));
}

export function movementTime(date: string) {
  return warehouseTime.format(new Date(date));
}

export function warehouseLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}
