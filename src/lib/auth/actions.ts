"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { allowRequest } from "@/lib/requests/rate-limit";
import { requestAvailability, requestsUnavailable } from "@/lib/requests/availability";
import { blockedSubmission, type RequestFormState } from "@/lib/requests/forms";
import { caughtInHoneypot, formErrors, readForm, signInSchema } from "@/lib/requests/validation";
import { sessionClient } from "./server";
import { signInTargetCookie, storefrontUrl } from "./supabase";

async function sendSignInLink(form: FormData, target: "trade" | "account"): Promise<RequestFormState> {
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
    if (!error) {
      (await cookies()).set(signInTargetCookie, target, {
        httpOnly: true,
        sameSite: "lax",
        secure: new URL(emailRedirectTo).protocol === "https:",
        path: "/auth/confirm",
        maxAge: 3600,
      });
      return { status: "success" };
    }
    if (error.code === "over_email_send_rate_limit") {
      return { status: "error", message: "Wait a minute before requesting another sign-in link." };
    }
  } catch {
  }
  return { status: "error", message: "We couldn’t send the sign-in link. Please try again shortly." };
}

export async function sendTradeSignInLink(_previous: RequestFormState, form: FormData) {
  return sendSignInLink(form, "trade");
}

export async function sendAccountSignInLink(_previous: RequestFormState, form: FormData) {
  return sendSignInLink(form, "account");
}

export async function signOut() {
  await (await sessionClient()).auth.signOut({ scope: "local" });
  redirect("/trade");
}

export async function signOutOfAccount() {
  const { error } = await (await sessionClient()).auth.signOut({ scope: "local" });
  redirect(error ? "/account?signout=retry" : "/account");
}
