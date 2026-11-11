import type { DirectoryPerson, DirectorySnapshot, DirectoryTeam } from "@/lib/directory/types";

export const TEAM_TECH: DirectoryTeam = { externalId: "group-engineering", name: "Engineering", active: true };
export const TEAM_OPS: DirectoryTeam = { externalId: "group-operations", name: "Operations", active: true };

export function directoryPerson(overrides: Partial<DirectoryPerson> & { externalId: string }): DirectoryPerson {
  return {
    subject: `sub-${overrides.externalId}`,
    displayName: `Person ${overrides.externalId}`,
    email: `${overrides.externalId}@example.test`,
    teamExternalId: TEAM_TECH.externalId,
    isAdmin: false,
    ...overrides,
  };
}

export function snapshot(people: DirectoryPerson[], teams: DirectoryTeam[] = [TEAM_TECH, TEAM_OPS]): DirectorySnapshot {
  return { people, teams };
}
