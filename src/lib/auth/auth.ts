import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { getAuthConfig, type AuthConfig } from "@/lib/config";
import { getDb, type Database } from "@/lib/db/client";
import { authAccount, authSession, authUser, authVerification } from "@/lib/db/schema";
import { getDirectory, type Directory } from "@/lib/directory/directory";
import { OIDC_PROVIDER_ID } from "@/lib/directory/sessions";
import { logger } from "@/lib/logger";
import { hasLoginAccess, NO_ACCESS_ERROR_CODE } from "./access";
import { discoveryUrl } from "./discovery-url";

export interface CreateAuthOptions {
  config: AuthConfig;
  directory: Directory;
  db: Database;
}

/**
 * The OIDC `sub` each login verified, by Better Auth endpoint context. The
 * OAuth callback writes the account row of that `sub` and then creates the
 * session, both in one request. The user ID alone does not say who logged in:
 * Better Auth links a new `sub` whose verified email matches an existing user
 * to that user.
 */
const loginAccounts = new WeakMap<object, { userId: string; subject: string }>();

function rememberLoginAccount(context: object | null, account: { providerId: string; accountId: string; userId: string } | null) {
  if (!context || account?.providerId !== OIDC_PROVIDER_ID) return;
  loginAccounts.set(context, { userId: account.userId, subject: account.accountId });
}

function loginSubjectOf(context: object | null, userId: string): string | undefined {
  const login = context ? loginAccounts.get(context) : undefined;
  return login?.userId === userId ? login.subject : undefined;
}

/**
 * Better Auth with one OpenID Connect provider (authorization code flow with
 * PKCE) as the only login. Endpoints, including logout, come from the
 * provider's discovery document. Sessions live in PostgreSQL and are read on
 * every request, so ending a session takes effect immediately.
 */
export function createAuth({ config, directory, db }: CreateAuthOptions) {
  return betterAuth({
    appName: "Logbuch",
    baseURL: config.LOGBUCH_BASE_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.LOGBUCH_BASE_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: authUser, session: authSession, account: authAccount, verification: authVerification },
    }),
    emailAndPassword: { enabled: false },
    session: {
      // No cookie cache: every request checks the session in the database.
      cookieCache: { enabled: false },
      additionalFields: {
        // Set by the session hook below, never from the request.
        oidcSubject: { type: "string", required: true, input: false },
      },
    },
    // Logbuch never uses the provider's access and refresh tokens, but
    // Better Auth stores them: keep them encrypted (with BETTER_AUTH_SECRET).
    // The ID token stays readable; logout sends it as `id_token_hint`.
    account: { encryptOAuthTokens: true },
    advanced: {
      cookiePrefix: "logbuch",
      useSecureCookies: config.LOGBUCH_BASE_URL.startsWith("https://"),
    },
    onAPIError: { errorURL: `${config.LOGBUCH_BASE_URL}/login` },
    databaseHooks: {
      account: {
        create: { after: async (account, context) => rememberLoginAccount(context, account) },
        update: { after: async (account, context) => rememberLoginAccount(context, account) },
      },
      session: {
        create: {
          // The access rule runs before a session exists, so people without
          // access never get one. The session keeps the `sub` it logged in
          // with; without one, there is no session.
          before: async (session, context) => {
            const subject = loginSubjectOf(context, session.userId);
            const allowed =
              subject !== undefined &&
              (await hasLoginAccess(db, { userId: session.userId, subject }, {
                directory,
                trustEmail: config.OIDC_TRUST_EMAIL,
              }));
            if (!allowed) {
              logger.info({ userId: session.userId }, "login denied: no access");
              throw new APIError("FORBIDDEN", {
                code: NO_ACCESS_ERROR_CODE,
                message: "You do not have access to Logbuch.",
              });
            }
            return { data: { ...session, oidcSubject: subject } };
          },
        },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: OIDC_PROVIDER_ID,
            discoveryUrl: discoveryUrl(config.OIDC_ISSUER),
            clientId: config.OIDC_CLIENT_ID,
            clientSecret: config.OIDC_CLIENT_SECRET,
            scopes: config.OIDC_SCOPES.split(/[\s,]+/).filter(Boolean),
            pkce: true,
            requireIdTokenVerification: true,
            postLogoutRedirectURI: `${config.LOGBUCH_BASE_URL}/`,
          },
        ],
      }),
      // Must be last: applies cookies set by auth.api calls in Server Actions.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { logbuchAuth?: Auth };

export function getAuth(): Auth {
  globalForAuth.logbuchAuth ??= createAuth({ config: getAuthConfig(), directory: getDirectory(), db: getDb() });
  return globalForAuth.logbuchAuth;
}
