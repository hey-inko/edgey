import "server-only";

import { createHmac } from "node:crypto";
import type { Database } from "@/lib/supabase/database.types";
import { isSingleMailbox } from "./address";
import { emailConfigurationError } from "./provider";

type Source = Pick<
  Database["public"]["Tables"]["order_outbox"]["Row"],
  "enquiry_id" | "trial_request_id" | "trade_application_id"
>;

export function requestEmailSource(claim: Source) {
  if (claim.enquiry_id) return { table: "enquiries", id: claim.enquiry_id, label: "Enquiry" } as const;
  if (claim.trial_request_id) return { table: "trial_requests", id: claim.trial_request_id, label: "Sample request" } as const;
  if (claim.trade_application_id) {
    return { table: "trade_applications", id: claim.trade_application_id, label: "Trade application" } as const;
  }
  return null;
}

function receiptHashKey() {
  const key = process.env.EDGEY_REQUEST_HASH_KEY;
  return key && Buffer.byteLength(key) >= 32 ? key : null;
}

export function requestStaffEmail() {
  const address = process.env.REQUEST_STAFF_EMAIL?.trim();
  return address && isSingleMailbox(address) ? address : null;
}

export function requestEmailConfigurationError() {
  return emailConfigurationError()
    ?? (!receiptHashKey() ? "EDGEY_REQUEST_HASH_KEY is not configured correctly." : null)
    ?? (!requestStaffEmail() ? "REQUEST_STAFF_EMAIL must be one valid email address." : null);
}

export function requestReceipt(from: string, email: string) {
  const key = receiptHashKey();
  const recipient = email.trim();
  if (!key || !isSingleMailbox(recipient)) return null;

  const subject = "Edgey received a request";
  const received = "We received a request submitted using this email address.";
  const ignore = "If you didn’t make the request, you can ignore this email.";
  const payload = JSON.stringify({
    from, to: [recipient], subject,
    text: `${received}\n\n${ignore}`,
    html: `<p>${received}</p><p>${ignore}</p>`,
  });
  const recipientFingerprint = createHmac("sha256", key).update(`request-receipt\0${recipient.toLowerCase()}`).digest("hex");
  return { payload, recipientFingerprint };
}

export function requestStaffNotice(from: string, to: string, source: NonNullable<ReturnType<typeof requestEmailSource>>) {
  const subject = `New Edgey request: ${source.label}`;
  const text = `Type: ${source.label}\nReference: ${source.id}`;
  const html = `<p>Type: ${source.label}</p><p>Reference: ${source.id}</p>`;
  return JSON.stringify({ from, to: [to], subject, text, html });
}

export function hasStaffDestination(payload: string, to: string) {
  try {
    const message: unknown = JSON.parse(payload);
    return message !== null && typeof message === "object" && "to" in message
      && Array.isArray(message.to) && message.to.length === 1 && message.to[0] === to
      && !("cc" in message) && !("bcc" in message);
  } catch {
    return false;
  }
}
