import { drainFinanceRetries } from "@/lib/admin/replay";
import { PaymentConfigurationError } from "@/lib/payments/config";
import { checkCron } from "@/lib/payments/cron";
import { reconcileStripePayments, replayStripeEvent } from "@/lib/payments/reconciliation";
import { getStripe } from "@/lib/payments/stripe";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = checkCron(request);
  if (denied) return denied;
  try {
    getStripe();
    const finance = await drainFinanceRetries("event", replayStripeEvent);
    return Response.json({ ...await reconcileStripePayments(), finance }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      error: error instanceof PaymentConfigurationError ? error.message : "Stripe reconciliation did not complete.",
    }, { status: 503 });
  }
}
