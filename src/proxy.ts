import { NextResponse, type NextRequest } from "next/server";
import { getAuthConfig } from "@/lib/config";
import { identityProviderOrigins } from "@/lib/auth/oidc-discovery";
import { buildContentSecurityPolicy } from "@/lib/security/csp";

/**
 * Sets the Content Security Policy with a fresh nonce for every page request.
 * Next.js reads the nonce from the request header and adds it to its scripts.
 * Access checks do not happen here; pages and actions call requireUser().
 */
export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    // Login and logout redirect to the identity provider.
    formActionOrigins: await identityProviderOrigins(getAuthConfig().OIDC_ISSUER),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Everything except API routes, health endpoints, and static files.
      source: "/((?!api/|-/|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
