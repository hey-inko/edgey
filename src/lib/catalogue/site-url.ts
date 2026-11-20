import "server-only";

export function siteUrl(path: string): string | undefined {
  const origin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  return origin ? new URL(path, origin).href : undefined;
}
