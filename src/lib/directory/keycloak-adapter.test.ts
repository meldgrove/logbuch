import { describe, expect, it, vi } from "vitest";
import { adminApiBase, createKeycloakDirectoryAdapter } from "./keycloak-adapter";
import { DirectoryError } from "./types";

const ISSUER = "https://auth.example.org/realms/acme";
const ADMIN = "https://auth.example.org/admin/realms/acme";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const user = (id: string, extra: Record<string, unknown> = {}) => ({ id, username: id, firstName: id.toUpperCase(), lastName: "Example", email: `${id}@example.org`, enabled: true, ...extra });

/**
 * A small Keycloak: groups by path, their members, and their subgroups.
 * Paging follows `first` and `max` like the Admin API.
 */
function fakeKeycloak(options: { groups: Record<string, { id: string; members?: ReturnType<typeof user>[]; children?: string[] }>; status?: Record<string, number> }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const byId = new Map(Object.entries(options.groups).map(([path, group]) => [group.id, { path, ...group }]));
  const page = <T,>(items: T[], url: URL) => {
    const first = Number(url.searchParams.get("first") ?? 0);
    const max = Number(url.searchParams.get("max") ?? 100);
    return items.slice(first, first + max);
  };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    for (const [prefix, status] of Object.entries(options.status ?? {})) {
      if (url.pathname.includes(prefix)) return new Response("", { status });
    }
    if (url.pathname.endsWith("/protocol/openid-connect/token")) return json({ access_token: "token-1", expires_in: 300 });
    const path = url.pathname.replace("/admin/realms/acme", "");
    const byPath = /^\/group-by-path\/(.+)$/.exec(path);
    if (byPath) {
      const groupPath = `/${decodeURIComponent(byPath[1]!).split("/").map(decodeURIComponent).join("/")}`;
      const group = options.groups[groupPath];
      return group ? json({ id: group.id, name: groupPath.split("/").at(-1), path: groupPath }) : new Response("", { status: 404 });
    }
    const members = /^\/groups\/([^/]+)\/members$/.exec(path);
    if (members) return json(page(byId.get(members[1]!)?.members ?? [], url));
    const children = /^\/groups\/([^/]+)\/children$/.exec(path);
    if (children) {
      const childPaths = byId.get(children[1]!)?.children ?? [];
      return json(page(childPaths.map((p) => ({ id: options.groups[p]!.id, name: p.split("/").at(-1), path: p })), url));
    }
    return new Response("not found", { status: 404 });
  });
  return { fetch: fetchMock as typeof fetch, calls };
}

const adapterFor = (keycloak: ReturnType<typeof fakeKeycloak>, extra: Partial<Parameters<typeof createKeycloakDirectoryAdapter>[0]> = {}) =>
  createKeycloakDirectoryAdapter({
    issuer: ISSUER,
    clientId: "logbuch",
    clientSecret: "s3cr:et",
    accessGroup: "/logbuch",
    fetch: keycloak.fetch,
    ...extra,
  });

describe("adminApiBase", () => {
  it("turns a realm URL into its Admin API URL", () => {
    expect(adminApiBase(ISSUER)).toBe(ADMIN);
    expect(adminApiBase("http://localhost:8090/auth/realms/dev/")).toBe("http://localhost:8090/auth/admin/realms/dev");
    expect(() => adminApiBase("https://accounts.example.org")).toThrow(DirectoryError);
  });
});

describe("createKeycloakDirectoryAdapter", () => {
  const groups = {
    "/logbuch": { id: "g-access", members: [user("erika"), user("off", { enabled: false })], children: ["/logbuch/contractors"] },
    "/logbuch/contractors": { id: "g-contractors", members: [user("carl", { firstName: "", lastName: "" })] },
    "/logbuch-admins": { id: "g-admins", members: [user("adam")] },
    "/teams": { id: "g-teams", children: ["/teams/Operations", "/teams/Engineering"] },
    "/teams/Engineering": { id: "g-eng", members: [user("erika")], children: ["/teams/Engineering/Platform"] },
    "/teams/Engineering/Platform": { id: "g-platform", members: [user("carl")] },
    "/teams/Operations": { id: "g-ops", members: [user("adam"), user("erika")] },
  };

  it("reads the access group with its subgroups, the admins, and the teams", async () => {
    const keycloak = fakeKeycloak({ groups });
    const snapshot = await adapterFor(keycloak, { adminGroup: "/logbuch-admins", teamsGroup: "/teams" }).fetchSnapshot();

    expect(snapshot.teams).toEqual([
      { externalId: "g-eng", name: "Engineering", active: true },
      { externalId: "g-ops", name: "Operations", active: true },
    ]);
    expect(snapshot.people.sort((a, b) => a.externalId.localeCompare(b.externalId))).toEqual([
      // Admins have access too.
      { externalId: "adam", subject: "adam", displayName: "ADAM Example", email: "adam@example.org", teamExternalId: "g-ops", isAdmin: true },
      // No name in Keycloak: the username.
      { externalId: "carl", subject: "carl", displayName: "carl", email: "carl@example.org", teamExternalId: "g-eng", isAdmin: false },
      // In two teams: the first by name.
      { externalId: "erika", subject: "erika", displayName: "ERIKA Example", email: "erika@example.org", teamExternalId: "g-eng", isAdmin: false },
    ]);
  });

  it("uses a client-credentials token against the Admin API", async () => {
    const keycloak = fakeKeycloak({ groups });
    await adapterFor(keycloak).fetchSnapshot();
    const token = keycloak.calls.find((c) => c.url.endsWith("/token"));
    expect(token?.url).toBe(`${ISSUER}/protocol/openid-connect/token`);
    const basic = Buffer.from(new Headers(token?.init?.headers).get("authorization")!.replace("Basic ", ""), "base64").toString();
    expect(basic).toBe("logbuch:s3cr%3Aet");
    const lookup = keycloak.calls.find((c) => c.url.includes("/group-by-path/"));
    expect(lookup?.url).toBe(`${ADMIN}/group-by-path/logbuch`);
    expect(new Headers(lookup?.init?.headers).get("authorization")).toBe("Bearer token-1");
  });

  it("reads every page of a large group", async () => {
    const many = Array.from({ length: 5 }, (_, i) => user(`p${i}`));
    const keycloak = fakeKeycloak({ groups: { "/logbuch": { id: "g-access", members: many } } });
    const snapshot = await adapterFor(keycloak, { pageSize: 2 }).fetchSnapshot();
    expect(snapshot.people.map((p) => p.externalId)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  });

  it("names a missing group and a missing permission", async () => {
    await expect(adapterFor(fakeKeycloak({ groups: {} })).fetchSnapshot()).rejects.toThrow("The Keycloak group /logbuch does not exist.");
    await expect(adapterFor(fakeKeycloak({ groups, status: { "/group-by-path/": 403 } })).fetchSnapshot()).rejects.toThrow(/view-users/);
  });

  it("reports a failed token request as a directory error", async () => {
    const keycloak = fakeKeycloak({ groups, status: { "/token": 401 } });
    await expect(adapterFor(keycloak).fetchSnapshot()).rejects.toBeInstanceOf(DirectoryError);
  });
});
