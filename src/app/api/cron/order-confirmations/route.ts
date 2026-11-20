import { drainFinanceRetries } from "@/lib/admin/replay";
import { processOrderConfirmations, replayOrderConfirmation } from "@/lib/email/outbox";
import { emailConfigurationError } from "@/lib/email/provider";
import { checkCron } from "@/lib/payments/cron";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const forbidden = checkCron(request);
  if (forbidden) return forbidden;
  const configurationError = emailConfigurationError();
  if (configurationError) return Response.json({ error: configurationError }, { status: 503 });
  try {
    const [orders, finance] = await Promise.all([
      processOrderConfirmations(), drainFinanceRetries("confirmation", replayOrderConfirmation),
    ]);
    return Response.json({ ...orders, finance }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not process order confirmations." }, { status: 500 });
  }
}
