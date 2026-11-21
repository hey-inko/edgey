import "server-only";
import { isSingleMailbox } from "@/lib/email/address";

export function publicContactEmail() {
  const email = process.env.EDGEY_PUBLIC_CONTACT_EMAIL?.trim();
  if (email && isSingleMailbox(email) && !/[?&#%]/.test(email)) return email;
}

export function publicPrivacyNotice(currentPath?: string) {
  const url = URL.parse(process.env.EDGEY_PRIVACY_NOTICE_URL ?? "");
  if (url?.protocol !== "https:" || url.username || url.password) return;
  if (currentPath) {
    const site = URL.parse(process.env.NEXT_PUBLIC_SITE_URL ?? "");
    if (url.origin === site?.origin && url.pathname.replace(/\/+$/, "") === currentPath) return;
  }
  return url.href;
}
