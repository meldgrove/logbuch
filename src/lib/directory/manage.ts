import { and, count, eq, ne, sql } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import type { Database, Transaction } from "@/lib/db/client";
import { person, team } from "@/lib/db/schema";
import { EntryError, type Actor } from "@/lib/entries/commands";
import type { Directory } from "./directory";
import { directoryChange, personChanges, type Check } from "./rules";
import type { InvitePersonInput, PreferencesInput, TeamInput, UpdatePersonInput } from "./schemas";
import { endSessionsForSubjects } from "./sessions";

/*
 * People and teams of the manual directory, managed by admins. Nothing is
 * deleted: a person who leaves loses access, a team is deactivated. What may
 * be changed is decided in rules.ts; with the Keycloak directory, nothing.
 */

type DirectoryRef = Pick<Directory, "editable">;

const invalid = (field: string, message: string) => new EntryError("invalid", message, { [field]: message });

function enforce(check: Check) {
  if (!check.ok) throw new EntryError(check.forbidden ? "forbidden" : "invalid", check.reason ?? "This is not possible.");
}

/**
 * Serializes invitations and changes to access and admin rights, so checks
 * that span people (a known email, the last admin) see each other's writes.
 * Taken first, before any row lock. 7_261_001 and 7_261_002 are the directory
 * sync and first logins.
 */
const PEOPLE_LOCK_KEY = 7_261_003;

async function lockPeople(tx: Transaction) {
  await tx.execute(sql`select pg_advisory_xact_lock(${PEOPLE_LOCK_KEY})`);
}

async function lockPerson(tx: Transaction, personId: string) {
  const [current] = await tx.select().from(person).where(eq(person.id, personId)).for("update");
  if (!current) throw new EntryError("not_found", "This person does not exist.");
  return current;
}

/** What `actor` may change about a locked person; the admin count holds under `lockPeople`. */
async function changesOf(tx: Transaction, directory: DirectoryRef, actor: Actor, current: typeof person.$inferSelect) {
  const [admins] = await tx
    .select({ value: count() })
    .from(person)
    .where(and(eq(person.isAdmin, true), eq(person.hasAccess, true)));
  return personChanges(directory, actor, current, admins?.value ?? 0);
}

async function assertActiveTeam(tx: Transaction, teamId: string | null) {
  if (teamId === null) return;
  const [found] = await tx.select({ isActive: team.isActive }).from(team).where(eq(team.id, teamId));
  if (!found?.isActive) throw invalid("teamId", "Choose an active team.");
}

/**
 * Invites a person by email. They get access at their first login with a
 * verified email address that matches.
 */
export async function invitePerson(db: Database, directory: DirectoryRef, actor: Actor, input: InvitePersonInput, now: Date = new Date()) {
  enforce(directoryChange(directory, actor));
  return db.transaction(async (tx) => {
    await lockPeople(tx);
    const [existing] = await tx
      .select({ id: person.id, hasAccess: person.hasAccess })
      .from(person)
      .where(sql`lower(${person.workEmail}) = ${input.email}`)
      .limit(1);
    if (existing) {
      throw invalid(
        "email",
        existing.hasAccess
          ? "This person already has access."
          : "This person is already listed without access. Give them access again in the list below.",
      );
    }
    await assertActiveTeam(tx, input.teamId);
    const [created] = await tx
      .insert(person)
      .values({
        displayName: input.name,
        workEmail: input.email,
        teamId: input.teamId,
        hasAccess: true,
        isAdmin: input.isAdmin,
        accessChangedAt: now,
      })
      .returning({ id: person.id });
    await recordAudit(tx, {
      actorId: actor.personId,
      action: "person.invited",
      payload: { personId: created!.id, email: input.email, isAdmin: input.isAdmin },
    });
    return created!;
  });
}

export async function updatePerson(
  db: Database,
  directory: DirectoryRef,
  actor: Actor,
  personId: string,
  input: UpdatePersonInput,
  now: Date = new Date(),
) {
  enforce(directoryChange(directory, actor));
  await db.transaction(async (tx) => {
    const current = await lockPerson(tx, personId);
    enforce((await changesOf(tx, directory, actor, current)).edit);
    if (current.displayName === input.name && current.teamId === input.teamId) return;
    if (current.teamId !== input.teamId) await assertActiveTeam(tx, input.teamId);
    await tx.update(person).set({ displayName: input.name, teamId: input.teamId, updatedAt: now }).where(eq(person.id, personId));
    await recordAudit(tx, {
      actorId: actor.personId,
      action: "person.updated",
      payload: { personId, from: { name: current.displayName, teamId: current.teamId }, to: input },
    });
  });
}

/**
 * Gives access back or takes it away. Taking it away ends the person's
 * sessions and their admin rights. Nobody can take away their own access, and
 * the last admin keeps theirs (rules.ts).
 */
export async function setPersonAccess(
  db: Database,
  directory: DirectoryRef,
  actor: Actor,
  personId: string,
  hasAccess: boolean,
  now: Date = new Date(),
) {
  enforce(directoryChange(directory, actor));
  await db.transaction(async (tx) => {
    await lockPeople(tx);
    const current = await lockPerson(tx, personId);
    if (current.hasAccess === hasAccess) return;
    enforce((await changesOf(tx, directory, actor, current)).access);
    await tx
      .update(person)
      .set({ hasAccess, isAdmin: hasAccess ? current.isAdmin : false, accessChangedAt: now, updatedAt: now })
      .where(eq(person.id, personId));
    if (!hasAccess && current.oidcSubject) await endSessionsForSubjects(tx, [current.oidcSubject]);
    await recordAudit(tx, {
      actorId: actor.personId,
      action: hasAccess ? "person.access_granted" : "person.access_revoked",
      payload: { personId, name: current.displayName },
    });
  });
}

/** Makes a person with access an admin, or takes admin rights away. There is always at least one admin. */
export async function setPersonAdmin(
  db: Database,
  directory: DirectoryRef,
  actor: Actor,
  personId: string,
  isAdmin: boolean,
  now: Date = new Date(),
) {
  enforce(directoryChange(directory, actor));
  await db.transaction(async (tx) => {
    await lockPeople(tx);
    const current = await lockPerson(tx, personId);
    if (current.isAdmin === isAdmin) return;
    enforce((await changesOf(tx, directory, actor, current)).admin);
    await tx.update(person).set({ isAdmin, updatedAt: now }).where(eq(person.id, personId));
    await recordAudit(tx, {
      actorId: actor.personId,
      action: isAdmin ? "person.admin_granted" : "person.admin_revoked",
      payload: { personId, name: current.displayName },
    });
  });
}

async function assertUniqueTeamName(tx: Transaction, name: string, exceptId?: string) {
  const [found] = await tx
    .select({ id: team.id })
    .from(team)
    .where(and(sql`lower(${team.name}) = lower(${name})`, exceptId ? ne(team.id, exceptId) : undefined))
    .limit(1);
  if (found) throw invalid("name", "A team with this name already exists.");
}

export async function createTeam(db: Database, directory: DirectoryRef, actor: Actor, input: TeamInput) {
  enforce(directoryChange(directory, actor));
  return db.transaction(async (tx) => {
    await assertUniqueTeamName(tx, input.name);
    const [created] = await tx.insert(team).values({ name: input.name }).returning({ id: team.id });
    await recordAudit(tx, { actorId: actor.personId, action: "team.created", payload: { teamId: created!.id, name: input.name } });
    return created!;
  });
}

async function lockTeam(tx: Transaction, teamId: string) {
  const [current] = await tx.select().from(team).where(eq(team.id, teamId)).for("update");
  if (!current) throw new EntryError("not_found", "This team does not exist.");
  return current;
}

export async function renameTeam(db: Database, directory: DirectoryRef, actor: Actor, teamId: string, input: TeamInput) {
  enforce(directoryChange(directory, actor));
  await db.transaction(async (tx) => {
    const current = await lockTeam(tx, teamId);
    if (current.name === input.name) return;
    await assertUniqueTeamName(tx, input.name, teamId);
    await tx.update(team).set({ name: input.name, updatedAt: new Date() }).where(eq(team.id, teamId));
    await recordAudit(tx, { actorId: actor.personId, action: "team.renamed", payload: { teamId, from: current.name, to: input.name } });
  });
}

/** Teams are never deleted; an inactive team stays on old entries but cannot be chosen. */
export async function setTeamActive(db: Database, directory: DirectoryRef, actor: Actor, teamId: string, isActive: boolean) {
  enforce(directoryChange(directory, actor));
  await db.transaction(async (tx) => {
    const current = await lockTeam(tx, teamId);
    if (current.isActive === isActive) return;
    await tx.update(team).set({ isActive, updatedAt: new Date() }).where(eq(team.id, teamId));
    await recordAudit(tx, {
      actorId: actor.personId,
      action: isActive ? "team.activated" : "team.deactivated",
      payload: { teamId, name: current.name },
    });
  });
}

/** A person's own display preferences. */
export async function savePreferences(db: Database, personId: string, input: PreferencesInput) {
  await db
    .update(person)
    .set({ timeZone: input.timeZone, dateFormat: input.dateFormat, updatedAt: new Date() })
    .where(eq(person.id, personId));
}
