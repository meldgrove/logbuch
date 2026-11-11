import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { startFakeOidcProvider, type FakeOidcProvider, type OidcIdentity } from "../../../tests/integration/oidc-provider";
import { getPool } from "@/lib/db/client";
import { authAccount, authSession, person } from "@/lib/db/schema";
import { createManualDirectory } from "@/lib/directory/manual";
import { endSessionsForSubjects } from "@/lib/directory/sessions";
import { createAuth, type Auth } from "./auth";
import { getCurrentPerson } from "./session";

// session.ts reads the request's cookies through next/headers.
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

const BASE_URL = "http://localhost:3000";
const testDb = connectTestDatabase();
const { db } = testDb;
let provider: FakeOidcProvider;
let auth: Auth;

beforeAll(async () => {
  provider = await startFakeOidcProvider();
  auth = createAuth({
    config: {
      LOGBUCH_BASE_URL: BASE_URL,
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
      OIDC_ISSUER: provider.issuer,
      OIDC_CLIENT_ID: provider.clientId,
      OIDC_CLIENT_SECRET: "test-client-secret",
      OIDC_SCOPES: "openid email profile",
      OIDC_TRUST_EMAIL: false,
    },
    directory: createManualDirectory({ initialAdmins: [] }),
    db,
  });
  // The auth that session.ts uses.
  (globalThis as { logbuchAuth?: Auth }).logbuchAuth = auth;
});
beforeEach(() => testDb.reset());
afterAll(async () => {
  await provider.close();
  await getPool().end();
  await testDb.close();
});

/** The cookies a response sets, as a request's Cookie header. Cleared cookies are left out. */
function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

/** Logs in through Better Auth's endpoints like a browser, with the fake provider approving `identity`. */
async function logIn(identity: OidcIdentity) {
  const start = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ provider: "oidc", callbackURL: "/" }),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorization = new URL(url);
  const code = provider.approve(url, identity);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  const response = await auth.handler(new Request(callback, { headers: { cookie: cookiesOf(start) } }));
  expect(response.status).toBe(302);
  return { response, cookie: cookiesOf(response), code };
}

/** The person `getCurrentPerson` finds for a request with these cookies. */
async function personFor(cookie: string) {
  request.headers = new Headers({ cookie });
  return getCurrentPerson();
}

async function addPerson(values: Partial<typeof person.$inferInsert>) {
  const [row] = await db.insert(person).values({ displayName: "Someone", hasAccess: true, ...values }).returning();
  return row!;
}

describe("login with the OIDC provider", () => {
  it("keeps each session with the person of the `sub` it logged in with", async () => {
    const ada = await addPerson({ oidcSubject: "sub-ada", displayName: "Ada" });
    const bea = await addPerson({ oidcSubject: "sub-bea", displayName: "Bea" });

    // Two subjects with the same verified email: Better Auth links both to one user.
    const first = await logIn({ sub: "sub-ada", email: "shared@example.org" });
    const second = await logIn({ sub: "sub-bea", email: "shared@example.org" });

    expect((await personFor(first.cookie))?.id).toBe(ada.id);
    expect((await personFor(second.cookie))?.id).toBe(bea.id);
    const sessions = await db.select().from(authSession).orderBy(authSession.createdAt);
    expect(sessions.map((s) => s.oidcSubject)).toEqual(["sub-ada", "sub-bea"]);
    expect(sessions[0]!.userId).toBe(sessions[1]!.userId);

    // Ending the sessions of one subject leaves the other's.
    await endSessionsForSubjects(db, ["sub-bea"]);
    expect((await personFor(first.cookie))?.id).toBe(ada.id);
    expect(await personFor(second.cookie)).toBeNull();
  });

  it("links an invitation at the first login", async () => {
    const invited = await addPerson({ workEmail: "erika@example.org" });
    const { cookie } = await logIn({ sub: "sub-erika", email: "erika@example.org", name: "Erika Example" });

    const current = await personFor(cookie);
    expect(current).toMatchObject({ id: invited.id, oidcSubject: "sub-erika", displayName: "Erika Example" });
  });

  it("stores the provider's access and refresh tokens encrypted, and logs out with the ID token", async () => {
    await addPerson({ oidcSubject: "sub-ada" });
    const { cookie, code } = await logIn({ sub: "sub-ada", email: "ada@example.org" });
    const issued = provider.tokensFor(code)!;

    const [account] = await db.select().from(authAccount).where(eq(authAccount.accountId, "sub-ada"));
    expect(account?.accessToken).toBeTruthy();
    expect(account?.accessToken).not.toContain(issued.accessToken);
    expect(account?.refreshToken).toBeTruthy();
    expect(account?.refreshToken).not.toContain(issued.refreshToken);
    expect(account?.idToken).toBe(issued.idToken);

    const signOut = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-out`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL, cookie },
        body: JSON.stringify({ callbackURL: "/", disableRedirect: true }),
      }),
    );
    const { url } = (await signOut.json()) as { url: string };
    expect(new URL(url).searchParams.get("id_token_hint")).toBe(issued.idToken);
    expect(await db.select().from(authSession)).toHaveLength(0);
  });

  it("gives no session to someone without access", async () => {
    await addPerson({ oidcSubject: "sub-lea", hasAccess: false });
    const { response, cookie } = await logIn({ sub: "sub-lea", email: "lea@example.org" });

    expect(response.headers.get("location")).toContain("/login?error=");
    expect(cookie).not.toContain("session_token");
    expect(await db.select().from(authSession)).toHaveLength(0);
    const [lea] = await db.select().from(person).where(eq(person.oidcSubject, "sub-lea"));
    expect(lea?.hasAccess).toBe(false);
  });
});
