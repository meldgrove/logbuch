import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Who logs in at the fake provider. */
export interface OidcIdentity {
  sub: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
}

/** The tokens the fake provider issued for one login. */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

export interface FakeOidcProvider {
  issuer: string;
  clientId: string;
  /** Approves a login started with this authorization URL; returns the code for the callback. */
  approve(authorizationUrl: string, identity: OidcIdentity): string;
  /** The tokens issued for a code, once the token endpoint exchanged it. */
  tokensFor(code: string): IssuedTokens | undefined;
  close(): Promise<void>;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/**
 * A minimal OpenID Connect provider for integration tests: discovery, JWKS,
 * and a token endpoint that returns RS256-signed ID tokens. The test plays the
 * browser: it approves the authorization URL Better Auth built and passes the
 * code to the callback.
 */
export async function startFakeOidcProvider(clientId = "logbuch-test"): Promise<FakeOidcProvider> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-key";
  const approved = new Map<string, { identity: OidcIdentity; nonce: string }>();
  const issued = new Map<string, IssuedTokens>();
  let issuer = "";

  function idToken(identity: OidcIdentity, nonce: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const claims = base64url(
      JSON.stringify({
        iss: issuer,
        aud: clientId,
        sub: identity.sub,
        email: identity.email,
        email_verified: identity.emailVerified ?? true,
        name: identity.name ?? identity.sub,
        nonce,
        iat: now,
        exp: now + 300,
      }),
    );
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey);
    return `${header}.${claims}.${base64url(signature)}`;
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    const json = (body: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.pathname === "/jwks") {
      return json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] });
    }
    if (url.pathname === "/token" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const code = new URLSearchParams(body).get("code") ?? "";
        const login = approved.get(code);
        approved.delete(code);
        if (!login) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const tokens = {
          accessToken: `access-${randomUUID()}`,
          refreshToken: `refresh-${randomUUID()}`,
          idToken: idToken(login.identity, login.nonce),
        };
        issued.set(code, tokens);
        json({
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          id_token: tokens.idToken,
          token_type: "Bearer",
          expires_in: 300,
        });
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    approve(authorizationUrl, identity) {
      const nonce = new URL(authorizationUrl).searchParams.get("nonce") ?? "";
      const code = randomUUID();
      approved.set(code, { identity, nonce });
      return code;
    },
    tokensFor: (code) => issued.get(code),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
