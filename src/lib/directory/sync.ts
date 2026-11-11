import { and, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import type { Transaction } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { directorySyncRun, person, team } from "@/lib/db/schema";
import { endSessionsForSubjects } from "./sessions";
import { errorMessage, logger } from "@/lib/logger";
import { DirectoryError, type DirectoryAdapter, type DirectorySnapshot } from "./types";

export type SyncTrigger = "schedule" | "startup" | "login" | "admin" | "manual";

export type SyncResult =
  | {
      status: "succeeded";
      runId: string;
      peopleReceived: number;
      teamsReceived: number;
      accessGranted: number;
      accessRemoved: number;
      sessionsEnded: number;
    }
  | { status: "failed"; runId: string; error: string }
  | { status: "skipped"; reason: "already_running" | "ran_recently" };

export interface SyncOptions {
  pool: Pool;
  adapter: DirectoryAdapter;
  trigger: SyncTrigger;
  /** Skip the run if the previous run started less than this many ms ago. */
  minIntervalMs?: number;
  now?: () => Date;
}

/** Key of the PostgreSQL advisory lock that allows one sync at a time. */
const SYNC_LOCK_KEY = 7_261_001;

/**
 * Pulls people and teams from the external directory into the local
 * projection.
 *
 * - People in the snapshot have access; their admin flag and team come from
 *   the directory.
 * - People missing from the snapshot lose access and their sessions end.
 *   Their rows stay: Logbuch never deletes people.
 * - A failed fetch, or a snapshot without people or teams, keeps the last
 *   projection.
 */
export async function syncDirectory(options: SyncOptions): Promise<SyncResult> {
  const now = options.now ?? (() => new Date());
  const client = await options.pool.connect();
  try {
    const locked = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [
      SYNC_LOCK_KEY,
    ]);
    if (!locked.rows[0]?.locked) return { status: "skipped", reason: "already_running" };
    try {
      return await runLocked(client, options, now);
    } finally {
      await client.query("select pg_advisory_unlock($1)", [SYNC_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function runLocked(client: PoolClient, options: SyncOptions, now: () => Date): Promise<SyncResult> {
  const db = drizzle(client, { schema });

  if (options.minIntervalMs !== undefined) {
    const [last] = await db
      .select({ startedAt: directorySyncRun.startedAt })
      .from(directorySyncRun)
      .orderBy(desc(directorySyncRun.startedAt))
      .limit(1);
    if (last && now().getTime() - last.startedAt.getTime() < options.minIntervalMs) {
      return { status: "skipped", reason: "ran_recently" };
    }
  }

  const [run] = await db
    .insert(directorySyncRun)
    .values({ trigger: options.trigger, status: "running", startedAt: now() })
    .returning({ id: directorySyncRun.id });
  if (!run) throw new Error("Could not record the directory sync run");

  try {
    const snapshot = await options.adapter.fetchSnapshot();
    assertPlausible(snapshot);
    const counts = await db.transaction((tx) => applySnapshot(tx, snapshot, now()));
    await db
      .update(directorySyncRun)
      .set({
        status: "succeeded",
        finishedAt: now(),
        peopleReceived: snapshot.people.length,
        teamsReceived: snapshot.teams.length,
        ...counts,
      })
      .where(eq(directorySyncRun.id, run.id));
    logger.info(
      { runId: run.id, trigger: options.trigger, adapter: options.adapter.name, people: snapshot.people.length, ...counts },
      "directory sync succeeded",
    );
    return {
      status: "succeeded",
      runId: run.id,
      peopleReceived: snapshot.people.length,
      teamsReceived: snapshot.teams.length,
      ...counts,
    };
  } catch (error) {
    const message = errorMessage(error);
    await db
      .update(directorySyncRun)
      .set({ status: "failed", finishedAt: now(), error: message.slice(0, 2_000) })
      .where(eq(directorySyncRun.id, run.id));
    logger.error({ runId: run.id, trigger: options.trigger, err: error }, "directory sync failed");
    return { status: "failed", runId: run.id, error: message };
  }
}

/** Rejects snapshots that would remove everyone's access or every team, or break uniqueness. */
export function assertPlausible(snapshot: DirectorySnapshot): void {
  if (snapshot.people.length === 0) {
    throw new DirectoryError("The directory returned no people. The current access list is kept.");
  }
  if (snapshot.teams.length === 0) {
    throw new DirectoryError(
      "The directory returned no teams: the teams group has no subgroups. Every entry needs a team, so the current people and teams are kept.",
    );
  }
  const duplicates = (values: string[]) => values.filter((value, index) => values.indexOf(value) !== index);
  const duplicatePeople = duplicates(snapshot.people.map((p) => p.externalId));
  const duplicateSubjects = duplicates(snapshot.people.map((p) => p.subject));
  const duplicateTeams = duplicates(snapshot.teams.map((t) => t.externalId));
  if (duplicatePeople.length > 0 || duplicateSubjects.length > 0 || duplicateTeams.length > 0) {
    throw new DirectoryError("The directory returned duplicate people, login subjects, or teams.");
  }
}

async function applySnapshot(tx: Transaction, snapshot: DirectorySnapshot, at: Date) {
  // Teams: upsert the listed ones by their directory ID.
  const teams = new Map(snapshot.teams.map((t) => [t.externalId, { name: t.name, isActive: t.active }]));
  if (teams.size > 0) {
    await tx
      .insert(team)
      .values([...teams].map(([externalId, t]) => ({ externalId, name: t.name, isActive: t.isActive })))
      .onConflictDoUpdate({
        target: team.externalId,
        set: { name: sql`excluded.name`, isActive: sql`excluded.is_active`, updatedAt: at },
      });
  }
  // Every other team is kept, but inactive: teams that disappeared from the
  // directory, and teams made by hand before the directory was used, which
  // nobody could deactivate otherwise. assertPlausible ensures the list is not empty.
  await tx
    .update(team)
    .set({ isActive: false, updatedAt: at })
    .where(and(eq(team.isActive, true), or(isNull(team.externalId), notInArray(team.externalId, [...teams.keys()]))));

  const teamRows = await tx.select({ id: team.id, externalId: team.externalId }).from(team);
  const teamIdByExternalId = new Map(teamRows.map((t) => [t.externalId, t.id]));

  const existing = await tx
    .select({
      id: person.id,
      externalId: person.externalId,
      oidcSubject: person.oidcSubject,
      hasAccess: person.hasAccess,
    })
    .from(person);
  const hadAccess = new Map(existing.map((p) => [p.externalId, p.hasAccess]));
  const accessGranted = snapshot.people.filter((p) => hadAccess.get(p.externalId) !== true).length;

  const listedIds = snapshot.people.map((p) => p.externalId);
  const listed = new Set(listedIds);

  // A login subject can move to another person in the directory. Free every
  // subject that changes owner before the upsert, so the unique constraint
  // holds. Rows that are no longer listed lose access with it.
  const ownerOfSubject = new Map(snapshot.people.map((p) => [p.subject, p.externalId]));
  const moved = existing.filter((p) => {
    const owner = p.oidcSubject === null ? undefined : ownerOfSubject.get(p.oidcSubject);
    return owner !== undefined && owner !== p.externalId;
  });
  const movedListed = moved.filter((p) => p.externalId !== null && listed.has(p.externalId)).map((p) => p.id);
  const movedUnlisted = moved.filter((p) => p.externalId === null || !listed.has(p.externalId)).map((p) => p.id);
  if (movedListed.length > 0) {
    await tx.update(person).set({ oidcSubject: null, updatedAt: at }).where(inArray(person.id, movedListed));
  }
  if (movedUnlisted.length > 0) {
    await tx
      .update(person)
      .set({ oidcSubject: null, hasAccess: false, isAdmin: false, accessChangedAt: at, updatedAt: at })
      .where(inArray(person.id, movedUnlisted));
  }

  await tx
    .insert(person)
    .values(
      snapshot.people.map((p) => ({
        externalId: p.externalId,
        oidcSubject: p.subject,
        displayName: p.displayName,
        workEmail: p.email?.trim() || null,
        teamId: p.teamExternalId ? (teamIdByExternalId.get(p.teamExternalId) ?? null) : null,
        hasAccess: true,
        isAdmin: p.isAdmin,
        accessChangedAt: at,
        lastSeenInDirectoryAt: at,
      })),
    )
    .onConflictDoUpdate({
      target: person.externalId,
      set: {
        oidcSubject: sql`excluded.oidc_subject`,
        displayName: sql`excluded.display_name`,
        workEmail: sql`excluded.work_email`,
        // A new work email means a new Slack lookup.
        slackUserId: sql`case when ${person.workEmail} is distinct from excluded.work_email then null else ${person.slackUserId} end`,
        slackLookupFailedAt: sql`case when ${person.workEmail} is distinct from excluded.work_email then null else ${person.slackLookupFailedAt} end`,
        teamId: sql`excluded.team_id`,
        hasAccess: sql`true`,
        isAdmin: sql`excluded.is_admin`,
        accessChangedAt: sql`case when ${person.hasAccess} then ${person.accessChangedAt} else excluded.access_changed_at end`,
        lastSeenInDirectoryAt: sql`excluded.last_seen_in_directory_at`,
        updatedAt: at,
      },
    });

  // Everyone else loses access, including people added by hand before the
  // directory was used. Their rows, names, and history stay.
  const removed = await tx
    .update(person)
    .set({ hasAccess: false, isAdmin: false, accessChangedAt: at, updatedAt: at })
    .where(
      and(
        eq(person.hasAccess, true),
        or(isNull(person.externalId), notInArray(person.externalId, listedIds)),
      ),
    )
    .returning({ oidcSubject: person.oidcSubject });

  // Freed subjects (moved users) are handled above; end the sessions of every
  // person who is no longer listed.
  const removedSubjects = removed.map((r) => r.oidcSubject).filter((s): s is string => s !== null);
  const sessionsEnded = await endSessionsForSubjects(tx, removedSubjects);

  return { accessGranted, accessRemoved: removed.length, sessionsEnded };
}
