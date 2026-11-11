import type { Pool } from "pg";
import { getDirectoryConfig, type DirectoryConfig } from "@/lib/config";
import { getPool, type Database } from "@/lib/db/client";
import { createKeycloakDirectoryAdapter } from "./keycloak-adapter";
import { createManualDirectory } from "./manual";
import { findPersonBySubject } from "./queries";
import { syncDirectory, type SyncResult, type SyncTrigger } from "./sync";

/*
 * Where people, teams, and access come from (DIRECTORY). Two adapters answer
 * the questions in which the directories differ, so callers never read
 * DIRECTORY themselves:
 *
 * - manual: admins invite people and manage teams in Logbuch. An invitation
 *   is linked at the first login; the first admin comes from
 *   INITIAL_ADMIN_EMAILS.
 * - keycloak: a sync brings people and teams from Keycloak groups, every 15
 *   minutes and when someone unknown logs in. They are changed in Keycloak.
 */

export type DirectoryKind = DirectoryConfig["DIRECTORY"];

export interface Directory {
  /** For logs. Callers ask the other members instead of branching on it. */
  readonly kind: DirectoryKind;
  /** Admins change people and teams in Logbuch. False when a sync brings them from Keycloak. */
  readonly editable: boolean;
  /** The sync from Keycloak, or null when there is nothing to sync. */
  readonly sync: DirectorySync | null;
  /**
   * Whether someone who logged in, but is not (yet) a person with access,
   * gets a session.
   */
  admitNewLogin(db: Database, login: NewLogin): Promise<boolean>;
}

export interface DirectorySync {
  /** Members of this Keycloak group have access. */
  readonly accessGroup: string;
  /** Members of this Keycloak group are admins. */
  readonly adminGroup: string;
  /** Runs a sync, unless one is running or (with `minIntervalMs`) the last one started too recently. */
  run(trigger: SyncTrigger, minIntervalMs?: number): Promise<SyncResult>;
}

export interface NewLogin {
  /** The Better Auth user. */
  userId: string;
  /** The OIDC `sub`. */
  subject: string;
  /** A person with this subject exists, without access. */
  known: boolean;
  /** Treat the provider's email addresses as verified (OIDC_TRUST_EMAIL). */
  trustEmail: boolean;
  now: Date;
}

/** On-demand directory syncs at login run at most once per minute. */
export const LOGIN_SYNC_MIN_INTERVAL_MS = 60_000;

/**
 * The Keycloak directory. Someone unknown may have been added to the access
 * group since the last sync: one sync runs (at most once per minute), and the
 * check repeats.
 */
export function createKeycloakDirectory(sync: DirectorySync): Directory {
  return {
    kind: "keycloak",
    editable: false,
    sync,
    async admitNewLogin(db, login) {
      await sync.run("login", LOGIN_SYNC_MIN_INTERVAL_MS);
      return (await findPersonBySubject(db, login.subject))?.hasAccess === true;
    },
  };
}

/** The directory for a configuration. `pool` is only used by the Keycloak sync. */
export function createDirectory(config: DirectoryConfig, pool: () => Pool): Directory {
  if (config.DIRECTORY === "manual") return createManualDirectory({ initialAdmins: config.INITIAL_ADMIN_EMAILS });
  const adapter = createKeycloakDirectoryAdapter({
    issuer: config.OIDC_ISSUER,
    clientId: config.KEYCLOAK_CLIENT_ID,
    clientSecret: config.KEYCLOAK_CLIENT_SECRET,
    accessGroup: config.KEYCLOAK_ACCESS_GROUP,
    adminGroup: config.KEYCLOAK_ADMIN_GROUP,
    teamsGroup: config.KEYCLOAK_TEAMS_GROUP,
  });
  return createKeycloakDirectory({
    accessGroup: config.KEYCLOAK_ACCESS_GROUP,
    adminGroup: config.KEYCLOAK_ADMIN_GROUP,
    run: (trigger, minIntervalMs) => syncDirectory({ pool: pool(), adapter, trigger, minIntervalMs }),
  });
}

let directory: Directory | undefined;

/** This process's directory, so the Keycloak token cache is shared. */
export function getDirectory(): Directory {
  directory ??= createDirectory(getDirectoryConfig(), getPool);
  return directory;
}
