import "server-only";

export function localRequestMode() {
  if (process.env.VERCEL === "1") return false;
  const origin = process.env.NEXT_PUBLIC_SITE_URL;
  if (!origin) return process.env.NODE_ENV === "development";
  const url = URL.parse(origin);
  return url?.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function requestAvailability() {
  if (localRequestMode()) return { enabled: true } as const;
  const url = URL.parse(process.env.EDGEY_PRIVACY_NOTICE_URL ?? "");
  if (process.env.EDGEY_PUBLIC_REQUESTS_ENABLED === "true" && url?.protocol === "https:") {
    return { enabled: true, privacyUrl: url.href } as const;
  }
  return { enabled: false } as const;
}

export const requestsUnavailable = "This form is not open for submissions yet.";
