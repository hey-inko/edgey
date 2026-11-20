import { processRequestEmails } from "@/lib/email/outbox";
import { requestEmailConfigurationError } from "@/lib/email/request-email";
import { checkCron } from "@/lib/payments/cron";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const forbidden = checkCron(request);
  if (forbidden) return forbidden;
  const configurationError = requestEmailConfigurationError();
  if (configurationError) return Response.json({ error: configurationError }, { status: 503 });
  try {
    return Response.json(await processRequestEmails(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not process request emails." }, { status: 500 });
  }
}
