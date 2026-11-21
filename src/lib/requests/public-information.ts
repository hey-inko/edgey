import "server-only";
import { isSingleMailbox } from "@/lib/email/address";

export function publicContactEmail() {
  const email = process.env.EDGEY_PUBLIC_CONTACT_EMAIL?.trim();
  if (email && isSingleMailbox(email) && !/[?&#%]/.test(email)) return email;
}

export function publicPrivacyNotice() {
  const url = URL.parse(process.env.EDGEY_PRIVACY_NOTICE_URL ?? "");
  if (url?.protocol === "https:" && !url.username && !url.password) return url.href;
}
