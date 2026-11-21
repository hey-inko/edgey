import { NextResponse, type NextRequest } from "next/server";
import { authCookieName, createAuthClient } from "@/lib/auth/supabase";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  if (request.method !== "GET" || !request.cookies.getAll().some(
    ({ name }) => name === authCookieName || name.startsWith(authCookieName + "."),
  )) return response;

  const client = createAuthClient({
    getAll: () => request.cookies.getAll(),
    setAll: (values, headers) => {
      for (const { name, value } of values) request.cookies.set(name, value);
      response = NextResponse.next({ request });
      for (const { name, value, options } of values) response.cookies.set(name, value, options);
      for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    },
  });
  await client.auth.getClaims();
  return response;
}

export const config = { matcher: ["/trade", "/admin/:path*", "/account/:path*", "/checkout", "/checkout/net30/:path*"] };
