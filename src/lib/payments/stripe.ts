import "server-only";
import Stripe from "stripe";
import { PaymentConfigurationError, requiredEnv } from "./config";

export const STRIPE_API_VERSION = "2026-11-18.endive";
let client: Stripe | undefined;

export function getStripe() {
  const key = requiredEnv("STRIPE_SECRET_KEY");
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new PaymentConfigurationError("STRIPE_SECRET_KEY must be a Stripe test-mode key.");
  }
  return client ??= new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    timeout: 5_000,
    maxNetworkRetries: 1,
  });
}
