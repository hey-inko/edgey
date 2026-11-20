"use server";

import { redirect } from "next/navigation";
import { allowRequest } from "@/lib/requests/rate-limit";
import type { RequestFormState } from "@/lib/requests/forms";
import { caughtInHoneypot, formErrors, readForm, signInSchema } from "@/lib/requests/validation";
import { sessionClient } from "./server";
import { storefrontUrl } from "./supabase";

export async function sendTradeSignInLink(_previous: RequestFormState, form: FormData): Promise<RequestFormState> {
  if (caughtInHoneypot(form)) return { status: "success" };
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
    if (!error || error.code === "over_email_send_rate_limit") return { status: "success" };
  } catch {
  }
  return { status: "error", message: "We couldn’t send the sign-in link. Please try again shortly." };
}

export async function signOut() {
  await (await sessionClient()).auth.signOut({ scope: "local" });
  redirect("/trade");
}
