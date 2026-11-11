import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWebhookClient, signWebhook, WebhookError } from "./client";
import type { WebhookPayload } from "./payload";

const SECRET = "a-long-shared-secret-for-tests";
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const payload = { event: "entry.changed", entry: { id: "e1", ref: "LB-1" } } as unknown as WebhookPayload;

function receiver(response: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response instanceof Error) throw response;
    return response;
  });
  return { fetch: fetchImpl as typeof fetch, calls };
}

describe("the webhook client", () => {
  it("posts the payload as JSON with a signature the receiver can check", async () => {
    const fake = receiver(new Response(null, { status: 204 }));
    await createWebhookClient({ url: "https://hooks.example.org/logbuch", secret: SECRET, fetch: fake.fetch, now: () => NOW }).send(payload);

    const { url, init } = fake.calls[0]!;
    expect(url).toBe("https://hooks.example.org/logbuch");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    const body = String(init.body);
    expect(JSON.parse(body)).toEqual(payload);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("logbuch-timestamp")).toBe(String(NOW / 1000));
    expect(headers.get("logbuch-delivery")).toMatch(/^[0-9a-f-]{36}$/);
    // What a receiver does: HMAC-SHA256 over "<timestamp>.<raw body>".
    const expected = createHmac("sha256", SECRET).update(`${headers.get("logbuch-timestamp")}.${body}`).digest("hex");
    expect(headers.get("logbuch-signature")).toBe(`sha256=${expected}`);
    expect(signWebhook(SECRET, NOW / 1000, body)).toBe(`sha256=${expected}`);
  });

  it("fails on any answer other than 2xx, and on network errors", async () => {
    const rejected = receiver(new Response("unknown signature", { status: 401 }));
    await expect(createWebhookClient({ url: "https://hooks.example.org/x", secret: SECRET, fetch: rejected.fetch }).send(payload)).rejects.toThrow(
      "The webhook answered HTTP 401 unknown signature",
    );
    const down = receiver(new Error("connect ECONNREFUSED"));
    await expect(createWebhookClient({ url: "https://hooks.example.org/x", secret: SECRET, fetch: down.fetch }).send(payload)).rejects.toBeInstanceOf(
      WebhookError,
    );
  });
});
