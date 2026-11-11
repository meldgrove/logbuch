/*
 * What an external directory (Keycloak) tells Logbuch: the people who have
 * access, and the teams. A sync replaces the local projection with it.
 */

export interface DirectoryTeam {
  /** Stable ID in the directory, e.g. the Keycloak group ID. */
  externalId: string;
  name: string;
  active: boolean;
}

export interface DirectoryPerson {
  /** Stable ID in the directory, e.g. the Keycloak user ID. */
  externalId: string;
  /** The OIDC `sub` the person logs in with. */
  subject: string;
  displayName: string;
  email: string | null;
  /** `externalId` of the person's team, or null. */
  teamExternalId: string | null;
  isAdmin: boolean;
}

export interface DirectorySnapshot {
  /** Everyone who has access. Everyone else loses it. */
  people: DirectoryPerson[];
  teams: DirectoryTeam[];
}

export interface DirectoryAdapter {
  readonly name: string;
  fetchSnapshot(): Promise<DirectorySnapshot>;
}

export class DirectoryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DirectoryError";
  }
}
