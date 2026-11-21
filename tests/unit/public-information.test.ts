import { afterEach, expect, test, vi } from "vitest";
import { publicContactEmail, publicPrivacyNotice } from "@/lib/requests/public-information";
import { indexableSiteOrigin } from "@/lib/catalogue/indexable-site";
import { finderAttributionEnabled } from "@/lib/commercial/privacy";
import { isReportedLookupCode } from "@/lib/commercial/returns";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllEnvs());

test("the contact shell only accepts an explicitly approved single public mailbox", () => {
  vi.stubEnv("REQUEST_STAFF_EMAIL", "private@example.test");
  for (const value of ["", "Contact <public@example.test>", "public@example.test,other@example.test", "x?subject@example.test"]) {
    vi.stubEnv("EDGEY_PUBLIC_CONTACT_EMAIL", value);
    expect(publicContactEmail()).toBeUndefined();
  }
  vi.stubEnv("EDGEY_PUBLIC_CONTACT_EMAIL", " public+enquiries@example.test ");
  expect(publicContactEmail()).toBe("public+enquiries@example.test");
});

test("the privacy shell links only an approved HTTPS notice without credentials", () => {
  for (const value of ["", "javascript:alert(0)", "http://example.test/privacy", "https://name:pass@example.test/privacy"]) {
    vi.stubEnv("EDGEY_PRIVACY_NOTICE_URL", value);
    expect(publicPrivacyNotice()).toBeUndefined();
  }
  vi.stubEnv("EDGEY_PRIVACY_NOTICE_URL", "https://example.test/privacy");
  expect(publicPrivacyNotice()).toBe("https://example.test/privacy");
});

test("the privacy shell hides a self-link but keeps a notice on another page or site", () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.test");
  const currentPage = { pathname: "/privacy", host: "preview.example.test" };
  for (const path of ["/privacy", "/privacy/", "/privacy?from=intake", "/privacy#notice"]) {
    for (const host of ["staging.example.test", "preview.example.test"]) {
      const url = `https://${host}${path}`;
      vi.stubEnv("EDGEY_PRIVACY_NOTICE_URL", url);
      expect(publicPrivacyNotice(currentPage)).toBeUndefined();
      expect(publicPrivacyNotice()).toBe(url);
    }
  }
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.stubEnv("EDGEY_PRIVACY_NOTICE_URL", "https://preview.example.test/privacy");
  expect(publicPrivacyNotice(currentPage)).toBeUndefined();
  for (const url of ["https://staging.example.test/legal/privacy", "https://example.test/privacy"]) {
    vi.stubEnv("EDGEY_PRIVACY_NOTICE_URL", url);
    expect(publicPrivacyNotice(currentPage)).toBe(url);
  }
});

test("even a valid HTTPS origin is not indexable without an explicit decision", async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.test");
  vi.stubEnv("EDGEY_INDEXING_ENABLED", "false");
  expect(indexableSiteOrigin()).toBeUndefined();
  expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  expect(await sitemap()).toEqual([]);
  vi.stubEnv("EDGEY_INDEXING_ENABLED", "true");
  for (const value of ["", "not a URL", "https://example.test/prefix", "http://example.test", "https://u@example.test"]) {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", value);
    expect(indexableSiteOrigin()).toBeUndefined();
  }
  for (const value of ["https://example.test", "http://127.0.0.1:3100"]) {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", value);
    expect(indexableSiteOrigin()).toBe(value);
  }
});

test("hosted deployments cannot enable optional attribution without a valid privacy notice", () => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("EDGEY_FINDER_ATTRIBUTION_ENABLED", "false");
  vi.stubEnv("EDGEY_PRIVACY_NOTICE_URL", "https://example.test/privacy");
  expect(finderAttributionEnabled()).toBe(false);
  vi.stubEnv("EDGEY_FINDER_ATTRIBUTION_ENABLED", "true");
  vi.stubEnv("EDGEY_PRIVACY_NOTICE_URL", "");
  expect(finderAttributionEnabled()).toBe(false);
  vi.stubEnv("EDGEY_PRIVACY_NOTICE_URL", "https://example.test/privacy");
  expect(finderAttributionEnabled()).toBe(true);
});

test("reported lookup accepts a code shape and excludes personal detail formats", () => {
  for (const code of ["3910301", "EDG-Z10", "42438135", "SPB 0030"]) expect(isReportedLookupCode(code)).toBe(true);
  for (const text of ["a@b.test", "Name Surname", "https://example.test/1", "SW1A 1AA", "198.51.100.24", "07700 900000"]) {
    expect(isReportedLookupCode(text)).toBe(false);
  }
});
