import "server-only";
import { isSingleMailbox } from "@/lib/email/address";

export function publicContactEmail() {
  const email = process.env.EDGEY_PUBLIC_CONTACT_EMAIL?.trim();
  if (email && isSingleMailbox(email) && !/[?&#%]/.test(email)) return email;
}

export function publicPrivacyNotice(currentPage?: { pathname: string; host: string | null }) {
  const url = URL.parse(process.env.EDGEY_PRIVACY_NOTICE_URL ?? "");
  if (url?.protocol !== "https:" || url.username || url.password) return;
  if (currentPage && url.pathname.replace(/\/+$/, "") === currentPage.pathname) {
    const site = URL.parse(process.env.NEXT_PUBLIC_SITE_URL ?? "");
    if (url.origin === site?.origin || url.host === currentPage.host?.toLowerCase()) return;
  }
  return url.href;
}
