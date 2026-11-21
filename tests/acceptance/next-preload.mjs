import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

const stripe = new URL(process.env.ACCEPTANCE_STRIPE_URL);
if (stripe.protocol !== "http:" || stripe.hostname !== "127.0.0.1" ||
    !process.env.ACCEPTANCE_CLOCK_FILE || !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
  throw new Error("The acceptance preload must only run against the local Stripe fixture.");
}

const request = https.request;
https.request = function (options, ...args) {
  if (options?.host !== "api.stripe.com") return request.call(this, options, ...args);
  return http.request({ ...options, host: stripe.hostname, port: stripe.port, agent: false }, ...args);
};

const NativeDate = Date;
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args, receiver) {
    const values = args.length ? args : [readFileSync(process.env.ACCEPTANCE_CLOCK_FILE, "utf8")];
    return Reflect.construct(target, values, receiver);
  },
});
