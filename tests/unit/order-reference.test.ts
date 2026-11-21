import { expect, it } from "vitest";
import { normaliseOrderReference } from "@/lib/orders/reference";

it("validates new and legacy references without confusing them with checkout tokens", () => {
  expect(normaliseOrderReference(" edg-2345-6789-abcdb ")).toBe("EDG-2345-6789-ABCDB");
  expect(normaliseOrderReference(" edg-00000042 ")).toBe("EDG-00000042");
  expect(normaliseOrderReference("EDG-2345-6789-ABDDB")).toBeNull();
  expect(normaliseOrderReference("EDG-2345-6789-ABCDA")).toBeNull();
  expect(normaliseOrderReference("EDG-2345-6789-ACBDB")).toBeNull();
  expect(normaliseOrderReference("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBeNull();
});
