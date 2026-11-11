import { z } from "zod";
import { logger } from "@/lib/logger";
import { originOf } from "@/lib/security/csp";
import { discoveryUrl } from "./discovery-url";

/*
 * The parts of the identity provider's discovery document that Logbuch needs
 * outside Better Auth: where the login and logout pages are (for the Content
 * Security Policy and for logging out without a session). Cached per process;
 * a failed fetch is retried after a minute.
 */

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  end_session_endpoint: z.url().optional(),
});

export interface OidcEndpoints {
  authorizationEndpoint: string;
  endSessionEndpoint?: string;
}

const RETRY_AFTER_MS = 60_000;
let cached: { issuer: string; value: OidcEndpoints } | undefined;
let failedAt = 0;
let pending: Promise<OidcEndpoints | null> | undefined;

async function fetchEndpoints(issuer: string, fetchImpl: typeof fetch): Promise<OidcEndpoints | null> {
  try {
    const response = await fetchImpl(discoveryUrl(issuer), { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = discoverySchema.parse(await response.json());
    const value = { authorizationEndpoint: parsed.authorization_endpoint, endSessionEndpoint: parsed.end_session_endpoint };
    cached = { issuer, value };
    return value;
  } catch (error) {
    failedAt = Date.now();
    logger.warn({ issuer, error: error instanceof Error ? error.message : String(error) }, "OIDC discovery failed");
    return null;
  }
}

/** The provider's login and logout endpoints, or null while its discovery document cannot be read. */
export async function getOidcEndpoints(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OidcEndpoints | null> {
  if (cached?.issuer === issuer) return cached.value;
  if (Date.now() - failedAt < RETRY_AFTER_MS) return null;
  pending ??= fetchEndpoints(issuer, fetchImpl).finally(() => {
    pending = undefined;
  });
  return pending;
}

/** Origins a form may submit or redirect to for login and logout. */
export async function identityProviderOrigins(issuer: string): Promise<string[]> {
  const endpoints = await getOidcEndpoints(issuer);
  const urls = [issuer, endpoints?.authorizationEndpoint, endpoints?.endSessionEndpoint];
  const origins = urls.map(originOf).filter((origin): origin is string => origin !== undefined);
  return [...new Set(origins)];
}
