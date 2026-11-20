import { startCheckoutAttempt } from "@/lib/checkout/server";
import type { CheckoutReviewResult } from "@/lib/checkout/types";
import { isRecord, normaliseAttemptToken, normaliseLines, validateCheckoutFields } from "@/lib/checkout/validation";
import { readRequestBody } from "@/lib/payments/body";
import { beginCardPayment, CheckoutUnavailableError } from "@/lib/payments/checkout";
import { checkoutOrigin, PaymentConfigurationError } from "@/lib/payments/config";

export const runtime = "nodejs";

type ReviewFailure = Exclude<CheckoutReviewResult, { status: "payment-unavailable" }>;
export type CheckoutSessionResult = ReviewFailure | { status: "payment"; sessionId: string; url: string }
  | { status: "error"; message: string; attemptClosed: true };

class NeedsCheckoutReview extends Error {
  constructor(readonly result: ReviewFailure) { super(result.message); }
}

function reply(result: CheckoutSessionResult, status: number) {
  return Response.json(result, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return reply({ status: "error", message: "Send the checkout details as JSON." }, 415);
  }
  let body: unknown;
  try {
    body = JSON.parse((await readRequestBody(request, 32 * 1_024)).toString());
  } catch (error) {
    return reply({ status: "error", message: "This checkout request is invalid." }, error instanceof RangeError ? 413 : 400);
  }
  const token = isRecord(body) ? normaliseAttemptToken(body.attemptToken) : null;
  const lines = isRecord(body) ? normaliseLines(body.lines) : null;
  if (!isRecord(body) || !token || !lines?.length || typeof body.quoteKey !== "string" || body.quoteKey.length > 64) {
    return reply({ status: "error", message: "This checkout attempt is invalid. Review your selection and try again." }, 400);
  }
  const validation = validateCheckoutFields(body.fields);
  if (!validation.ok) {
    return reply({ status: "invalid", errors: validation.errors, message: "Check the highlighted details before continuing." }, 422);
  }
  const { email, businessName, recipientName, buyingForWork, line1, line2, town, region, postcode } = validation.fields;
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== checkoutOrigin()) {
      return reply({ status: "error", message: "Start payment from the Edgey checkout." }, 403);
    }
    const payment = await beginCardPayment({
      attemptToken: token,
      lines,
      contact: { email, businessName, recipientName, buyingForWork },
      address: { line1, line2: line2 || undefined, town, region: region || undefined, postcode, country: "GB" },
    }, async () => {
      const result = await startCheckoutAttempt(body);
      if (result.status !== "ready") throw new NeedsCheckoutReview(result);
      return result.orderInput;
    });
    return reply({ status: "payment", ...payment }, 200);
  } catch (error) {
    if (error instanceof NeedsCheckoutReview) {
      return reply(error.result, error.result.status === "review" ? 409 : 422);
    }
    if (error instanceof PaymentConfigurationError) {
      return reply({ status: "error", message: `Card payment isn’t configured. ${error.message}` }, 503);
    }
    if (error instanceof CheckoutUnavailableError) return reply({
      status: "error", message: error.message, ...(error.attemptClosed ? { attemptClosed: true as const } : {}),
    }, 409);
    if (["insufficient_stock", "variant_not_published", "stale_unit_price"].includes((error as { message?: string })?.message ?? "")) {
      return reply({ status: "review", quote: await currentQuote(body), message: "Your quote has changed. Review the selection before continuing." }, 409);
    }
    return reply({ status: "error", message: "We couldn’t open payment right now. Try again from this checkout." }, 502);
  }
}

async function currentQuote(body: Record<string, unknown>) {
  const result = await startCheckoutAttempt(body);
  return result.status === "ready" || result.status === "review"
    ? result.quote
    : { status: "error" as const, message: result.message };
}
