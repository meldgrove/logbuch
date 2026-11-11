import { and, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Database, Transaction } from "@/lib/db/client";
import { directorySyncRun, person, team, workerHeartbeat } from "@/lib/db/schema";
import { OIDC_PROVIDER_ID } from "./sessions";

export { OIDC_PROVIDER_ID };

export type PersonRow = typeof person.$inferSelect;

export async function findPersonBySubject(db: Database | Transaction, subject: string): Promise<PersonRow | undefined> {
  const [row] = await db.select().from(person).where(eq(person.oidcSubject, subject)).limit(1);
  return row;
}

/** The worker writes a heartbeat every 30 seconds. */
const WORKER_STALE_AFTER_MS = 2 * 60_000;

export async function getDirectoryStatus(db: Database, now: Date = new Date()) {
  const [recentRuns, [withAccess], admins, [teams], [heartbeat]] = await Promise.all([
    db.select().from(directorySyncRun).orderBy(desc(directorySyncRun.startedAt)).limit(10),
    db.select({ value: count() }).from(person).where(eq(person.hasAccess, true)),
    db
      .select({ id: person.id, displayName: person.displayName, workEmail: person.workEmail })
      .from(person)
      .where(and(eq(person.hasAccess, true), eq(person.isAdmin, true)))
      .orderBy(person.displayName),
    db.select({ value: count() }).from(team).where(eq(team.isActive, true)),
    db.select().from(workerHeartbeat).where(isNotNull(workerHeartbeat.beatAt)).orderBy(desc(workerHeartbeat.beatAt)).limit(1),
  ]);
  return {
    recentRuns,
    lastSuccessfulRun: recentRuns.find((run) => run.status === "succeeded"),
    peopleWithAccess: withAccess?.value ?? 0,
    admins,
    activeTeams: teams?.value ?? 0,
    workerHeartbeat: heartbeat,
    workerHealthy: heartbeat !== undefined && now.getTime() - heartbeat.beatAt.getTime() < WORKER_STALE_AFTER_MS,
  };
}

/** Everyone Logbuch knows, for the People page: with access first, then by name. */
export async function listPeople(db: Database) {
  return db
    .select({
      id: person.id,
      displayName: person.displayName,
      workEmail: person.workEmail,
      teamId: person.teamId,
      teamName: team.name,
      hasAccess: person.hasAccess,
      isAdmin: person.isAdmin,
      /** False while an invitation waits for the first login. */
      hasLoggedIn: isNotNull(person.oidcSubject),
      accessChangedAt: person.accessChangedAt,
    })
    .from(person)
    .leftJoin(team, eq(team.id, person.teamId))
    .orderBy(desc(person.hasAccess), sql`lower(${person.displayName})`);
}

/** Every team with how many people with access belong to it. */
export async function listTeams(db: Database) {
  return db
    .select({
      id: team.id,
      name: team.name,
      isActive: team.isActive,
      members: sql<number>`(select count(*)::int from person member where member.team_id = "team"."id" and member.has_access)`,
    })
    .from(team)
    .orderBy(desc(team.isActive), sql`lower(${team.name})`);
}

/** Whether any team can own an entry. Without one, nobody can create entries. */
export async function hasActiveTeam(db: Database): Promise<boolean> {
  const [row] = await db.select({ id: team.id }).from(team).where(eq(team.isActive, true)).limit(1);
  return row !== undefined;
}
