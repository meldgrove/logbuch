import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, originOf } from "./csp";

describe("buildContentSecurityPolicy", () => {
  it("allows scripts only with the nonce in production", () => {
    const csp = buildContentSecurityPolicy({ nonce: "abc", isDev: false, formActionOrigins: [] });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("allows eval only in development", () => {
    const csp = buildContentSecurityPolicy({ nonce: "abc", isDev: true, formActionOrigins: [] });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("lets forms redirect to Keycloak", () => {
    const csp = buildContentSecurityPolicy({
      nonce: "abc",
      isDev: false,
      formActionOrigins: ["https://auth.example.org"],
    });
    expect(csp).toContain("form-action 'self' https://auth.example.org");
  });
});

describe("originOf", () => {
  it("returns the origin of http(s) URLs only", () => {
    expect(originOf("https://auth.example.org/realms/acme")).toBe(
      "https://auth.example.org",
    );
    expect(originOf("javascript:alert(1)")).toBeUndefined();
    expect(originOf("not a url")).toBeUndefined();
    expect(originOf(undefined)).toBeUndefined();
  });
});
