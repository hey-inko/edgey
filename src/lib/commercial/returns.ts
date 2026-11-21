export const returnCategories = {
  wrong_fit: "Wrong fit",
  damaged: "Damaged",
  ordered_in_error: "Ordered in error",
  other: "Other",
} as const;

export type ReturnCategory = keyof typeof returnCategories;

export function isReturnCategory(value: string): value is ReturnCategory {
  return Object.hasOwn(returnCategories, value);
}

export function isReportedLookupCode(value: string) {
  return value.length >= 2 && value.length <= 40 && /^[a-z0-9]+([ ._-][a-z0-9]+)*$/i.test(value)
    && /[0-9]/.test(value) && !/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(value) && !privateFinderQuery(value);
}
import { privateFinderQuery } from "@/lib/requests/finder-query";
