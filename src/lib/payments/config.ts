export class PaymentConfigurationError extends Error {}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new PaymentConfigurationError(`${name} is not configured.`);
  return value;
}

export function checkoutOrigin() {
  const value = requiredEnv("NEXT_PUBLIC_SITE_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentConfigurationError("NEXT_PUBLIC_SITE_URL must be a storefront origin.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new PaymentConfigurationError("NEXT_PUBLIC_SITE_URL must be an HTTPS storefront origin or local HTTP origin.");
  }
  return url.origin;
}
