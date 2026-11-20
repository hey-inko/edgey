import { z } from "zod";
import { parseUkPostcode } from "@/lib/commerce/coverage";
import { MACHINE_BRANDS, type RequestFormState } from "./forms";

function text(label: string, max: number, multiline = false) {
  return optionalText(max, multiline).min(1, `Enter ${label}.`);
}

function optionalText(max: number, multiline = false) {
  return z.string({ error: "Enter text only." }).trim().max(max, `Use ${max} characters or fewer.`).refine(
    (value) => !Array.from(multiline ? value.replace(/[\n\r\t]/g, "") : value)
      .some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    "Remove control characters and try again.",
  );
}

const email = z.string({ error: "Enter a valid email address." }).trim().toLowerCase().max(254, "Enter a valid email address.").pipe(
  z.email({ error: "Enter a valid email address." }),
);
const brand = z.enum(MACHINE_BRANDS.map(([value]) => value), { error: "Choose a machine brand." });
const postcode = z.string({ error: "Enter a full UK postcode." }).transform((value, ctx) => {
  const result = parseUkPostcode(value);
  if (result.ok) return result.value.normalised;
  ctx.addIssue({ code: "custom", message: "Enter a full UK postcode, for example SW1A 1AA." });
  return z.NEVER;
});
const attemptId = z.uuid({ error: "Reload the page and try again." });

export const signInSchema = z.object({ email });
export const compatibilitySchema = z.object({
  attemptId,
  email,
  query: optionalText(80),
  machineBrand: z.union([z.literal(""), brand], { error: "Choose a machine brand or leave it blank." }),
  message: text("a message", 2000, true),
});
export const deliveryEnquirySchema = z.object({
  attemptId,
  email,
  postcode,
  message: text("a message", 2000, true),
});
export const trialSchema = z.object({
  attemptId,
  machineBrand: brand,
  oemCode: text("the OEM code, or type “unknown”", 80).transform((value) =>
    value.toLowerCase() === "unknown" ? "unknown" : value,
  ),
  email,
  company: text("your company name", 200),
  postcode,
});
export const tradeSchema = z.object({
  attemptId,
  buyerName: text("the buyer’s full name", 200),
  company: text("your company name", 200),
  billingLine1: text("the first line of your billing address", 200),
  billingLine2: optionalText(200),
  billingTown: text("a town or city", 100),
  billingPostcode: postcode,
});

export function readForm<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>, form: FormData) {
  return schema.safeParse(Object.fromEntries(
    Object.keys(schema.shape).map((key) => [key, form.get(key) ?? ""]),
  ));
}

export function formErrors(error: z.ZodError): RequestFormState {
  const errors: NonNullable<RequestFormState["errors"]> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !Object.hasOwn(errors, key)) errors[key] = issue.message;
  }
  return { status: "error", errors, message: errors.attemptId ?? "Check the fields below and try again." };
}

export function caughtInHoneypot(form: FormData): boolean {
  return form.getAll("website").some((value) => value !== "");
}
