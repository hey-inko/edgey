import { processOrderConfirmations } from "@/lib/email/outbox";
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
    return Response.json(await processOrderConfirmations(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not process order confirmations." }, { status: 500 });
  }
}
