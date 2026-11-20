import { describe, expect, it } from "vitest";
import { normaliseFinderCode, normaliseFinderWords, privateFinderQuery } from "@/lib/requests/finder-query";
import {
  caughtInHoneypot,
  compatibilitySchema,
  deliveryEnquirySchema,
  formErrors,
  readForm,
  tradeSchema,
  trialSchema,
} from "@/lib/requests/validation";

const attemptId = "175faca0-ce37-412c-b635-2a563ea7ecd9";

function submission(values: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ attemptId, ...values })) form.append(key, value);
  return form;
}

describe("request validation", () => {
  it("permits only the five trial fields plus the attempt identity and normalises contact inputs", () => {
    const result = readForm(trialSchema, submission({
      machineBrand: "jwei", oemCode: " UNKNOWN ", email: " Buyer@Example.com ",
      company: " Proof Room ", postcode: "sw1a1aa", address: "extra", status: "approved",
    }));
    expect(result).toEqual({
      success: true,
      data: { attemptId, machineBrand: "jwei", oemCode: "unknown", email: "buyer@example.com", company: "Proof Room", postcode: "SW1A 1AA" },
    });
  });

  it("accepts a compatibility enquiry without a known code but validates the brand and message", () => {
    const form = submission({ email: "buyer@example.com", machineBrand: "iecho", message: "Model unknown.\nWhich holder fits?" });
    expect(readForm(compatibilitySchema, form).success).toBe(true);
    form.set("machineBrand", "invalid");
    form.set("message", "before\0after");
    const result = readForm(compatibilitySchema, form);
    if (result.success) throw new Error("Expected validation to fail.");
    expect(formErrors(result.error).errors).toMatchObject({
      machineBrand: "Choose a machine brand or leave it blank.",
      message: "Remove control characters and try again.",
    });
  });

  it("requires a complete postcode for a delivery enquiry", () => {
    const form = submission({ email: "buyer@example.com", message: "Can you quote delivery?", postcode: "HS1" });
    expect(readForm(deliveryEnquirySchema, form).success).toBe(false);
    form.set("postcode", "HS1 2AA");
    expect(readForm(deliveryEnquirySchema, form).success).toBe(true);
  });

  it("never uses submitted buyer IDs, email addresses or approval fields for trade", () => {
    const result = readForm(tradeSchema, submission({
      buyerName: "Print Buyer", company: "Proof Room", billingLine1: "1 Print Lane", billingTown: "London",
      billingPostcode: "SW1A 1AA", buyerId: "other", email: "other@example.com", status: "approved",
    }));
    expect(result).toEqual({
      success: true,
      data: { attemptId, buyerName: "Print Buyer", company: "Proof Room", billingLine1: "1 Print Lane",
        billingLine2: "", billingTown: "London", billingPostcode: "SW1A 1AA" },
    });
  });

  it("detects a populated honeypot even with a duplicate empty value", () => {
    const form = submission({ website: "" });
    expect(caughtInHoneypot(form)).toBe(false);
    form.append("website", "filled");
    expect(caughtInHoneypot(form)).toBe(true);
  });
});

describe("Finder analytics privacy", () => {
  it("normalises public codes and labels independently", () => {
    expect(normaliseFinderCode(" edg-z 10 ")).toBe("EDGZ10");
    expect(normaliseFinderWords("  Zünd–   Zünd-roll   ")).toBe("zund zund roll");
  });

  it.each(["buyer@example.com", "+44 (0)20 7123 4567", "SW1A 1AA", "www.example.com"])("redacts direct personal input %s", (query) => {
    expect(privateFinderQuery(query)).toBe(true);
  });
});
