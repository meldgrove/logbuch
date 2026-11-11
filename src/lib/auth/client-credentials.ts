import { z } from "zod";

/*
 * OAuth 2.0 client-credentials tokens for service clients (the Keycloak Admin
 * API). Tokens are cached until shortly before they expire; parallel callers
 * share one token request.
 */

export class TokenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokenError";
  }
}

export interface ClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface TokenSource {
  get(): Promise<string>;
  /** Drops the cached token, e.g. after the API answered HTTP 401. */
  invalidate(): void;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
});

/** A cached token is replaced this long before it expires. */
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

export function createClientCredentials(options: ClientCredentialsOptions): TokenSource {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let cached: { value: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  async function requestToken(): Promise<string> {
    // client_secret_basic: id and secret are form-encoded, then base64-encoded (RFC 6749, 2.3.1).
    const credentials = Buffer.from(
      `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`,
    ).toString("base64");
    let response: Response;
    try {
      response = await fetchImpl(options.tokenUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TokenError(`Request to ${new URL(options.tokenUrl).origin} failed: ${(error as Error).message}`, { cause: error });
    }
    if (!response.ok) throw new TokenError(`Token request failed with HTTP ${response.status}`);
    const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new TokenError("The token response is invalid");
    cached = { value: parsed.data.access_token, expiresAt: now() + parsed.data.expires_in * 1000 };
    return cached.value;
  }

  return {
    async get() {
      if (cached && cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now()) return cached.value;
      pending ??= requestToken().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
