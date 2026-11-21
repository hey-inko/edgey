import type Stripe from "stripe";
import { readRequestBody } from "@/lib/payments/body";
import { PaymentConfigurationError, requiredEnv } from "@/lib/payments/config";
import { acceptStripeEvent, stripeEventId } from "@/lib/payments/events";
import { getStripe } from "@/lib/payments/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "Invalid Stripe signature." }, { status: 400 });
  try {
    const stripe = getStripe();
    const secret = requiredEnv("STRIPE_WEBHOOK_SECRET");
    let event: Stripe.Event;
    try {
      const body = await readRequestBody(request, 512 * 1_024);
      event = stripe.webhooks.constructEvent(body, signature, secret);
      if (event.livemode !== false || event.account || event.context || !stripeEventId.test(event.id)) {
        return Response.json({ error: "Unexpected Stripe event." }, { status: 400 });
      }
    } catch {
      return Response.json({ error: "Invalid Stripe signature or payload." }, { status: 400 });
    }
    await acceptStripeEvent(stripe, event);
    return Response.json({ received: true });
  } catch (error) {
    if (error instanceof PaymentConfigurationError) console.error("Stripe webhook configuration is unavailable.");
    return Response.json({ error: "Could not record the Stripe event." }, { status: 503 });
  }
}
