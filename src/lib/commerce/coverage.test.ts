import { describe, expect, it } from "vitest";
import {
  calculateBasket,
  calculateDispatchPromise,
  lookupDeliveryCoverage,
  parseUkPostcode,
  PLACEHOLDER_DELIVERY_COVERAGE,
  STANDARD_DELIVERY_QUOTE,
  type DeliveryQuote,
} from "./index";

describe("UK postcode syntax and coverage", () => {
  it.each([
    [" m1   1aa ", "M1 1AA", "M", "M1"],
    ["M601NW", "M60 1NW", "M", "M60"],
    ["cR2 6Xh", "CR2 6XH", "CR", "CR2"],
    ["DN55 1PT", "DN55 1PT", "DN", "DN55"],
    ["W1A1HQ", "W1A 1HQ", "W", "W1A"],
    ["W1P1AA", "W1P 1AA", "W", "W1P"],
    ["N1P 1AA", "N1P 1AA", "N", "N1P"],
    [" ec1a\t1bb ", "EC1A 1BB", "EC", "EC1A"],
    ["GIR0AA", "GIR 0AA", "GIR", "GIR"],
  ])("normalises %s and extracts its area and district", (raw, normalised, area, district) => {
    expect(parseUkPostcode(raw)).toEqual({ ok: true, value: { normalised, area, district } });
  });

  it.each(["", "SW1A", "SW1A 1", "S W1A 1AA", "SW1A-1AA", "SW1A 1CC", "Q1 1AA", "SW1A 1AA London"])(
    "rejects invalid or incomplete postcode %s",
    (postcode) => {
      expect(lookupDeliveryCoverage(postcode, PLACEHOLDER_DELIVERY_COVERAGE))
        .toEqual({ ok: false, error: { code: "invalid_postcode" } });
    },
  );

  it("rejects oversized postcode input before normalising whitespace", () => {
    expect(parseUkPostcode(`SW1A${" ".repeat(500)}1AA`)).toEqual({
      ok: false, error: { code: "invalid_postcode" },
    });
  });

  it("quotes mainland next-working-day service for a supported area", () => {
    expect(lookupDeliveryCoverage("sw1a1aa", PLACEHOLDER_DELIVERY_COVERAGE)).toEqual({
      ok: true,
      value: {
        kind: "covered",
        postcode: { normalised: "SW1A 1AA", area: "SW", district: "SW1A" },
        quote: STANDARD_DELIVERY_QUOTE,
      },
    });
  });

  it.each(["IV2 3AY", "BT1 5GS", "HS1 2AQ", "PO30 1UD", "TR21 0LL", "IM1 1AA"])(
    "requires an enquiry for the valid but unsupported postcode %s",
    (postcode) => {
      expect(lookupDeliveryCoverage(postcode, PLACEHOLDER_DELIVERY_COVERAGE)).toMatchObject({
        ok: true, value: { kind: "enquiry-required", postcode: { normalised: postcode } },
      });
    },
  );

  it("supports an agreed slower service and charge by area and allows district exceptions", () => {
    const agreed: DeliveryQuote = {
      kind: "agreed", serviceName: "Highland delivery", chargeExVatPence: 1_250, workingDays: 3,
    };
    const table = { areas: { IV: agreed }, districts: { IV1: null, IV3: STANDARD_DELIVERY_QUOTE } };
    expect(lookupDeliveryCoverage("iv2 3ay", table)).toMatchObject({
      ok: true, value: { kind: "covered", quote: agreed },
    });
    expect(lookupDeliveryCoverage("IV1 1AA", table)).toMatchObject({ ok: true, value: { kind: "enquiry-required" } });
    expect(lookupDeliveryCoverage("IV3 1AA", table)).toMatchObject({
      ok: true, value: { kind: "covered", quote: STANDARD_DELIVERY_QUOTE },
    });
  });

  it("does not quote carrier terms that have an invalid charge", () => {
    expect(lookupDeliveryCoverage("IV2 3AY", {
      areas: { IV: { kind: "agreed", serviceName: "Highland delivery", workingDays: 2, chargeExVatPence: -1 } },
    })).toEqual({ ok: false, error: { code: "invalid_delivery_quote" } });
  });

  it("carries the lookup's agreed service into both the order price and delivery estimate", () => {
    const chargeExVatPence = 1_250;
    const coverage = lookupDeliveryCoverage("IV2 3AY", {
      areas: { IV: { kind: "agreed", serviceName: "Highland delivery", workingDays: 2, chargeExVatPence } },
    });
    expect(coverage).toMatchObject({ ok: true, value: { kind: "covered" } });
    if (!coverage.ok || coverage.value.kind !== "covered") return;

    const { quote } = coverage.value;
    expect(calculateBasket({
      variants: [{
        id: "z10",
        sku: "EDG-Z10",
        optionLabel: null,
        availableQuantity: 10,
        tierPrices: { oneToFour: 2_250, fiveToNine: 1_995, tenPlus: 1_750 },
      }],
      lines: [{ variantId: "z10", quantity: 10 }],
      deliveryQuote: quote,
    })).toMatchObject({
      ok: true, value: { delivery: { quote, netPence: chargeExVatPence, grossPence: 1_500 } },
    });
    expect(calculateDispatchPromise({ authorisedAt: "2026-11-20T15:29:00Z", deliveryQuote: quote })).toEqual({
      ok: true, value: { dispatchDate: "2026-11-20", estimatedDeliveryDate: "2026-11-24" },
    });
  });
});
