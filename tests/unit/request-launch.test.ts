import { afterEach, expect, it, vi } from "vitest";
import { localRequestMode, requestAvailability } from "@/lib/requests/availability";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllEnvs());

it("keeps hosted submissions closed unless operations opts in and sets an HTTPS notice", () => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
  vi.stubEnv("EDGEY_PUBLIC_REQUESTS_ENABLED", "");
  vi.stubEnv("EDGEY_PRIVACY_NOTICE_URL", "https://example.com/privacy");
  expect(localRequestMode()).toBe(false);
  expect(requestAvailability()).toEqual({ enabled: false });
  vi.stubEnv("EDGEY_PUBLIC_REQUESTS_ENABLED", "true");
  vi.stubEnv("EDGEY_PRIVACY_NOTICE_URL", "http://example.com/privacy");
  expect(requestAvailability()).toEqual({ enabled: false });
  vi.stubEnv("EDGEY_PRIVACY_NOTICE_URL", "https://example.com/privacy");
  expect(requestAvailability()).toEqual({ enabled: true, privacyUrl: "https://example.com/privacy" });
});

it("allows the local browser suite without requiring hosted notice configuration", () => {
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.0.0.1:3100");
  vi.stubEnv("EDGEY_PUBLIC_REQUESTS_ENABLED", "");
  expect(requestAvailability()).toEqual({ enabled: true });
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://shop.example.com");
  expect(requestAvailability()).toEqual({ enabled: false });
});
