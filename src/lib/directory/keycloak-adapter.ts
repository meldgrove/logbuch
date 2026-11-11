import { z } from "zod";
import { createClientCredentials, TokenError } from "@/lib/auth/client-credentials";
import { DirectoryError, type DirectoryAdapter, type DirectoryPerson, type DirectoryTeam } from "./types";

/*
 * Reads people and teams from Keycloak groups through the Keycloak Admin API,
 * with a client-credentials token of a service account that has the
 * realm-management role `view-users`.
 *
 * - Members of the access group (and of its subgroups) have access.
 * - Members of the admin group (and of its subgroups) are admins, and have
 *   access too.
 * - Every direct subgroup of the teams group is a team. A person's team is
 *   the first team group, by name, that lists them (directly or through a
 *   subgroup).
 * - Disabled users have no access.
 */

export interface KeycloakDirectoryOptions {
  /** The realm's issuer URL, e.g. https://auth.example.org/realms/acme. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  accessGroup: string;
  adminGroup?: string;
  teamsGroup?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Page size of member and subgroup lists. */
  pageSize?: number;
}

const groupSchema = z.object({ id: z.string().min(1), name: z.string(), path: z.string().optional() });
const userSchema = z.object({
  id: z.string().min(1),
  username: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().optional(),
  enabled: z.boolean().optional(),
});
type KeycloakUser = z.infer<typeof userSchema>;
type KeycloakGroup = z.infer<typeof groupSchema>;

/** The Admin API base of a realm: …/realms/<realm> becomes …/admin/realms/<realm>. */
export function adminApiBase(issuer: string): string {
  const url = issuer.replace(/\/+$/, "");
  const match = /^(.*)\/realms\/([^/]+)$/.exec(url);
  if (!match) throw new DirectoryError(`${issuer} is not a Keycloak realm URL (…/realms/<realm>)`);
  return `${match[1]}/admin/realms/${match[2]}`;
}

/** "First Last", or the username when both are empty. */
export function displayNameOf(user: KeycloakUser): string {
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name || user.username || user.email || user.id;
}

export function createKeycloakDirectoryAdapter(options: KeycloakDirectoryOptions): DirectoryAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pageSize = options.pageSize ?? 100;
  const issuer = options.issuer.replace(/\/+$/, "");
  const base = adminApiBase(issuer);
  const tokens = createClientCredentials({
    tokenUrl: `${issuer}/protocol/openid-connect/token`,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    fetch: fetchImpl,
    now: options.now,
    timeoutMs,
  });

  async function getToken(): Promise<string> {
    try {
      return await tokens.get();
    } catch (error) {
      if (error instanceof TokenError) throw new DirectoryError(`Keycloak: ${error.message}`, { cause: error });
      throw error;
    }
  }

  async function request(url: string, token: string): Promise<Response> {
    try {
      return await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DirectoryError(`Request to ${new URL(url).origin} failed: ${(error as Error).message}`, { cause: error });
    }
  }

  /** GET on the Admin API; null for HTTP 404. One retry with a fresh token after HTTP 401. */
  async function getJson<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T> | null> {
    const url = `${base}${path}`;
    let response = await request(url, await getToken());
    if (response.status === 401) {
      tokens.invalidate();
      response = await request(url, await getToken());
    }
    if (response.status === 404) return null;
    if (response.status === 403) {
      throw new DirectoryError("Keycloak refused the request (HTTP 403). The service account needs the realm-management role view-users.");
    }
    if (!response.ok) throw new DirectoryError(`Keycloak Admin API ${path.split("?")[0]} answered HTTP ${response.status}`);
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new DirectoryError(`Keycloak Admin API ${path.split("?")[0]} returned an invalid body`);
    return parsed.data;
  }

  async function groupByPath(path: string): Promise<KeycloakGroup> {
    const encoded = path
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const group = await getJson(`/group-by-path/${encoded}`, groupSchema);
    if (!group) throw new DirectoryError(`The Keycloak group ${path} does not exist.`);
    return group;
  }

  async function paged<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>[]> {
    const items: z.infer<T>[] = [];
    for (let first = 0; ; first += pageSize) {
      const separator = path.includes("?") ? "&" : "?";
      const page = await getJson(`${path}${separator}first=${first}&max=${pageSize}`, z.array(schema));
      if (!page) throw new DirectoryError(`Keycloak Admin API ${path} was not found.`);
      items.push(...page);
      if (page.length < pageSize) return items;
    }
  }

  const children = (groupId: string) => paged(`/groups/${encodeURIComponent(groupId)}/children?briefRepresentation=true`, groupSchema);

  /** Members of a group and of all its subgroups, by user ID. */
  async function membersOf(groupId: string, seen = new Set<string>()): Promise<Map<string, KeycloakUser>> {
    const members = new Map<string, KeycloakUser>();
    if (seen.has(groupId)) return members;
    seen.add(groupId);
    for (const user of await paged(`/groups/${encodeURIComponent(groupId)}/members?briefRepresentation=true`, userSchema)) {
      members.set(user.id, user);
    }
    for (const child of await children(groupId)) {
      for (const [id, user] of await membersOf(child.id, seen)) members.set(id, user);
    }
    return members;
  }

  return {
    name: "keycloak",
    async fetchSnapshot() {
      const accessGroup = await groupByPath(options.accessGroup);
      const users = await membersOf(accessGroup.id);
      const adminIds = new Set<string>();
      if (options.adminGroup) {
        const admins = await membersOf((await groupByPath(options.adminGroup)).id);
        for (const [id, user] of admins) {
          adminIds.add(id);
          if (!users.has(id)) users.set(id, user);
        }
      }

      const teams: DirectoryTeam[] = [];
      const teamOf = new Map<string, string>();
      if (options.teamsGroup) {
        const teamGroups = (await children((await groupByPath(options.teamsGroup)).id)).sort((a, b) => a.name.localeCompare(b.name));
        for (const group of teamGroups) {
          teams.push({ externalId: group.id, name: group.name, active: true });
          for (const id of (await membersOf(group.id)).keys()) {
            if (!teamOf.has(id)) teamOf.set(id, group.id);
          }
        }
      }

      const people: DirectoryPerson[] = [...users.values()]
        .filter((user) => user.enabled !== false)
        .map((user) => ({
          externalId: user.id,
          subject: user.id,
          displayName: displayNameOf(user),
          email: user.email?.trim() || null,
          teamExternalId: teamOf.get(user.id) ?? null,
          isAdmin: adminIds.has(user.id),
        }));
      return { people, teams };
    },
  };
}
