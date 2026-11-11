"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth/auth";
import { getAuthConfig } from "@/lib/config";
import { getOidcEndpoints } from "@/lib/auth/oidc-discovery";
import { OIDC_PROVIDER_ID } from "@/lib/directory/sessions";

/** Starts the login at the identity provider (authorization code flow with PKCE). */
export async function signInAction(): Promise<void> {
  const result = await getAuth().api.signInSocial({
    body: { provider: OIDC_PROVIDER_ID, callbackURL: "/", errorCallbackURL: "/login" },
    headers: await headers(),
  });
  if (!result.url) throw new Error("Better Auth returned no authorization URL");
  redirect(result.url);
}

/**
 * Ends the Logbuch session and then the identity provider's session
 * (RP-initiated logout with `id_token_hint`), so the next login asks for
 * credentials again.
 */
export async function signOutAction(): Promise<void> {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (session) {
    const result = await auth.api.signOut({
      headers: requestHeaders,
      body: { callbackURL: "/", disableRedirect: true },
    });
    redirect(result.url ?? "/login");
  }
  // No Logbuch session, for example after a denied login: end only the
  // identity provider's session, so the person can sign in with another
  // account. Providers without a logout endpoint keep their session.
  const config = getAuthConfig();
  const endSession = (await getOidcEndpoints(config.OIDC_ISSUER))?.endSessionEndpoint;
  if (!endSession) redirect("/login");
  const logoutUrl = new URL(endSession);
  logoutUrl.searchParams.set("client_id", config.OIDC_CLIENT_ID);
  logoutUrl.searchParams.set("post_logout_redirect_uri", `${config.LOGBUCH_BASE_URL}/`);
  redirect(logoutUrl.toString());
}
