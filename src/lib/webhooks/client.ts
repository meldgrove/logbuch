import { createHmac, randomUUID } from "node:crypto";
import type { WebhookPayload } from "./payload";

/*
 * Posts payloads to the webhook URL. Each request is signed with HMAC-SHA256
 * over "<timestamp>.<body>" with WEBHOOK_SECRET, so the receiver can check
 * that it comes from Logbuch and is recent:
 *
 *   Logbuch-Timestamp: <Unix time in seconds>
 *   Logbuch-Signature: sha256=<hex digest>
 *   Logbuch-Delivery: <random ID of this request>
 *
 * Any 2xx answer counts as delivered.
 */

export class WebhookError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebhookError";
  }
}

export interface WebhookClient {
  send(payload: WebhookPayload): Promise<void>;
}

/** The signature header value for a body sent at `timestamp` (Unix seconds). */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function createWebhookClient(options: {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): WebhookClient {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async send(payload) {
      const body = JSON.stringify(payload);
      const timestamp = Math.floor(now() / 1000);
      let response: Response;
      try {
        response = await fetchImpl(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Logbuch-Webhook",
            "logbuch-timestamp": String(timestamp),
            "logbuch-signature": signWebhook(options.secret, timestamp, body),
            "logbuch-delivery": randomUUID(),
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new WebhookError(`Request to ${new URL(options.url).origin} failed: ${(error as Error).message}`, { cause: error });
      }
      if (!response.ok) {
        const text = (await response.text().catch(() => "")).slice(0, 300);
        throw new WebhookError(`The webhook answered HTTP ${response.status} ${text}`.trim());
      }
    },
  };
}
