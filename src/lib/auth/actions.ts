"use server";

import { redirect } from "next/navigation";
import { allowRequest } from "@/lib/requests/rate-limit";
import { requestAvailability, requestsUnavailable } from "@/lib/requests/availability";
import { blockedSubmission, type RequestFormState } from "@/lib/requests/forms";
import { caughtInHoneypot, formErrors, readForm, signInSchema } from "@/lib/requests/validation";
import { sessionClient } from "./server";
import { storefrontUrl } from "./supabase";

export async function sendTradeSignInLink(_previous: RequestFormState, form: FormData): Promise<RequestFormState> {
  if (!requestAvailability().enabled) return { status: "error", message: requestsUnavailable };
  if (caughtInHoneypot(form)) return blockedSubmission;
  const input = readForm(signInSchema, form);
  if (!input.success) return formErrors(input.error);
  try {
    if (!await allowRequest("trade_sign_in", input.data.email)) {
      return { status: "error", message: "Too many sign-in requests. Please try again later." };
    }
    const emailRedirectTo = storefrontUrl("/auth/confirm").href;
    const { error } = await (await sessionClient()).auth.signInWithOtp({
      email: input.data.email,
      options: { emailRedirectTo },
    });
    if (!error) return { status: "success" };
    if (error.code === "over_email_send_rate_limit") {
      return { status: "error", message: "Wait a minute before requesting another sign-in link." };
    }
  } catch {
  }
  return { status: "error", message: "We couldn’t send the sign-in link. Please try again shortly." };
}

export async function signOut() {
  await (await sessionClient()).auth.signOut({ scope: "local" });
  redirect("/trade");
}
