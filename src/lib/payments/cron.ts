import "server-only";
import { timingSafeEqual } from "node:crypto";

export function checkCron(request: Request): Response | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret) < 32) {
    console.error("Cron authentication configuration is unavailable.");
    return Response.json({ error: "This job is unavailable." }, { status: 503 });
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
}
