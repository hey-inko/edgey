import { NextResponse, type NextRequest } from "next/server";
import { sessionClient } from "@/lib/auth/server";
import { signInTargetCookie, storefrontUrl } from "@/lib/auth/supabase";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  let verified = false;
  if (code && code.length <= 256) {
    const { error } = await (await sessionClient()).auth.exchangeCodeForSession(code);
    verified = !error;
  }
  const target = request.cookies.get(signInTargetCookie)?.value === "account" ? "/account" : "/trade";
  const response = NextResponse.redirect(storefrontUrl(verified ? target : target + "?signin=retry"));
  if (verified) response.cookies.set(signInTargetCookie, "", { path: "/auth/confirm", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
