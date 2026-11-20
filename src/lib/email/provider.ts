import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type ProviderName = "file" | "resend";
export type SendResult =
  | { status: "sent"; id: string }
  | { status: "provider_rejected" | "provider_rate_limited" | "provider_uncertain" | "provider_conflict" };
type Provider = { name: ProviderName; send: (key: string, body: string) => Promise<SendResult> };

export function resendProvider(apiKey: string): Provider {
  return {
    name: "resend",
    async send(key, body) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 429) return { status: "provider_rate_limited" };
        if (response.status === 409) {
          const error: unknown = await response.json().catch(() => null);
          return error && typeof error === "object" && "name" in error && error.name === "concurrent_idempotent_requests"
            ? { status: "provider_uncertain" }
            : { status: "provider_conflict" };
        }
        if ([400, 401, 403, 404, 422].includes(response.status)) return { status: "provider_rejected" };
        if (response.ok) {
          const data: unknown = await response.json();
          if (data && typeof data === "object" && "id" in data && typeof data.id === "string"
            && /^[a-zA-Z0-9_-]{1,200}$/.test(data.id)) return { status: "sent", id: data.id };
        }
      } catch {
        return { status: "provider_uncertain" };
      }
      return { status: "provider_uncertain" };
    },
  };
}

export function fileProvider(directory: string): Provider {
  return {
    name: "file",
    async send(key, body) {
      const id = createHash("sha256").update(key).digest("hex");
      const target = join(directory, `${id}.json`);
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(body);
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await link(temporary, target);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
          if (await readFile(target, "utf8") !== body) return { status: "provider_conflict" };
        }
        const folder = await open(directory, "r");
        try {
          await folder.sync();
        } finally {
          await folder.close();
        }
        return { status: "sent", id };
      } catch {
        return { status: "provider_uncertain" };
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },
  };
}

export function getEmailProvider() {
  if ((process.env.EMAIL_PROVIDER || "resend") === "resend") {
    const key = process.env.RESEND_API_KEY?.trim();
    if (key) return resendProvider(key);
  }
  if (process.env.EMAIL_PROVIDER === "file") {
    const directory = process.env.EMAIL_OUTBOX_DIR?.trim();
    if (directory && isAbsolute(directory)) return fileProvider(directory);
  }
  return null;
}

export function emailConfigurationError() {
  if (!getEmailProvider()) {
    return process.env.EMAIL_PROVIDER === "file"
      ? "EMAIL_OUTBOX_DIR must be an absolute path."
      : !process.env.EMAIL_PROVIDER || process.env.EMAIL_PROVIDER === "resend"
        ? "RESEND_API_KEY is not configured."
        : "EMAIL_PROVIDER must be resend or file.";
  }
  const from = process.env.EMAIL_FROM?.trim();
  return !from || /[\r\n]/.test(from) ? "EMAIL_FROM is not configured correctly." : null;
}
