import { PaymentConfigurationError } from "@/lib/payments/config";
import { checkCron } from "@/lib/payments/cron";
import { reconcileStripePayments } from "@/lib/payments/reconciliation";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = checkCron(request);
  if (denied) return denied;
  try {
    return Response.json(await reconcileStripePayments(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      error: error instanceof PaymentConfigurationError ? error.message : "Stripe reconciliation did not complete.",
    }, { status: 503 });
  }
}
