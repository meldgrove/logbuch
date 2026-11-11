import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit, type AuditAction } from "@/lib/audit";
import { notifyAddendum, notifyEntryPost } from "@/lib/notifications/notify";
import { requestWebhook } from "@/lib/webhooks/sync";
import type { Database, Transaction } from "@/lib/db/client";
import {
  addendum,
  decision,
  entry,
  entryAffectedTeam,
  entryImport,
  entryRelation,
  entryRevision,
  entryTag,
  outcome,
  participant,
  person,
  tag,
  team,
} from "@/lib/db/schema";
import { serverDate } from "@/lib/format";
import type { Impact, Reversibility } from "./constants";
import type { AddendumInput, DecisionInput, FieldErrors, ImportedDecisionInput, ImportedNoteInput, NoteInput, TagInput } from "./schemas";

/*
 * Writes for logged entries (updates, learnings, and decisions), impact,
 * addenda, and tags. Every write runs in one transaction with its audit
 * event. Proposals and their status changes belong to the process module.
 */

/**
 * What an entry write changed, as the command states it. `writeEntry` runs
 * these effects after the write.
 */
interface EntryEffects<T> {
  entryId: string;
  audit: { action: AuditAction; payload?: Record<string, unknown> };
  /** The text the search reads changed. */
  searchText?: boolean;
  /** Post the entry to the Logbuch Slack channel. */
  post?: boolean;
  /** Tell the people on the entry about this addendum. */
  addendumId?: string;
  /** The entry's webhook payload changed. */
  webhook?: boolean;
  /** What the command returns. */
  result?: T;
}

/**
 * Runs an entry write in one transaction: `run` checks, writes, and states
 * its effects, or returns null when nothing changed. Then, in this order: the
 * audit event, the search text, the messages, and the webhook.
 */
async function writeEntry<T = void>(
  db: Database,
  actor: Actor,
  now: Date,
  run: (tx: Transaction) => Promise<EntryEffects<T> | null>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const effects = await run(tx);
    if (!effects) return undefined as T;
    const { entryId } = effects;
    await recordAudit(tx, { actorId: actor.personId, entryId, ...effects.audit });
    if (effects.searchText) await refreshSearchText(tx, entryId);
    if (effects.post) await notifyEntryPost(tx, entryId, actor.personId, now);
    if (effects.addendumId) await notifyAddendum(tx, entryId, effects.addendumId, actor.personId, now);
    if (effects.webhook) await requestWebhook(tx, entryId, now);
    return effects.result as T;
  });
}

export interface Actor {
  personId: string;
  isAdmin: boolean;
}

export class EntryError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "invalid",
    message: string,
    readonly fieldErrors: FieldErrors = {},
  ) {
    super(message);
    this.name = "EntryError";
  }
}

const invalid = (field: string, message: string) => new EntryError("invalid", message, { [field]: message });

/** Statuses of a decision in force or on record: logged, or a decided proposal. */
export const DECIDED_STATUSES = ["published", "decided"] as const;

/** How an entry is logged. Only the import of old entries changes the defaults. */
export interface LogOptions {
  /** `false` skips the post to the Logbuch Slack channel. */
  announce?: boolean;
  /** The source identity, recorded in the same transaction (unique: a second import of the same source fails and writes nothing). */
  importedFrom?: { source: string; externalId: string };
  /**
   * When the entry was originally published, for old entries: the timeline
   * sorts them by it, and "Must read" counts from it, as if the entry had
   * been logged then. Defaults to now.
   */
  publishedAt?: Date;
}

// ---------------------------------------------------------------------------
// Reference checks
// ---------------------------------------------------------------------------

export async function assertActiveTeam(tx: Transaction, teamId: string) {
  const [row] = await tx.select({ id: team.id }).from(team).where(and(eq(team.id, teamId), eq(team.isActive, true)));
  if (!row) throw invalid("teamId", "Choose an active team.");
}

export async function assertTeams(tx: Transaction, field: string, teamIds: string[]) {
  if (teamIds.length === 0) return;
  const rows = await tx.select({ id: team.id }).from(team).where(inArray(team.id, teamIds));
  if (rows.length !== teamIds.length) throw invalid(field, "Choose teams from the list.");
}

export async function assertActiveTags(tx: Transaction, tagIds: string[]) {
  if (tagIds.length === 0) return;
  const rows = await tx.select({ id: tag.id }).from(tag).where(and(inArray(tag.id, tagIds), eq(tag.isActive, true)));
  if (rows.length !== tagIds.length) throw invalid("tagIds", "Choose tags from the list.");
}

/** Only people with access can be selected. */
export async function assertPeopleWithAccess(tx: Transaction, field: string, personIds: string[]) {
  if (personIds.length === 0) return;
  const rows = await tx
    .select({ id: person.id })
    .from(person)
    .where(and(inArray(person.id, personIds), eq(person.hasAccess, true)));
  if (rows.length !== personIds.length) throw invalid(field, "Choose people who have access to Logbuch.");
}

export async function assertPublishedEntries(tx: Transaction, field: string, entryIds: string[]) {
  if (entryIds.length === 0) return;
  const rows = await tx
    .select({ id: entry.id })
    .from(entry)
    .where(and(inArray(entry.id, entryIds), inArray(entry.status, [...DECIDED_STATUSES])));
  if (rows.length !== entryIds.length) throw invalid(field, "Choose published entries or decisions.");
}

/** Rebuilds the text that full-text search covers beyond title and summary. */
export async function refreshSearchText(tx: Transaction, entryId: string) {
  await tx.execute(sql`
    update entry set search_text = concat_ws(E'\n\n',
      nullif(entry.body, ''),
      nullif(entry.rationale, ''),
      (select concat_ws(E'\n\n', p.question,
         (select v.text from proposal_version v where v.entry_id = p.entry_id order by v.number desc limit 1))
       from proposal p where p.entry_id = entry.id),
      (select concat_ws(E'\n\n', nullif(o.final_text, ''), o.objection_handling) from outcome o where o.entry_id = entry.id),
      (select string_agg(a.text, E'\n\n' order by a.created_at) from addendum a where a.entry_id = entry.id)
    )
    where entry.id = ${entryId}
  `);
}

export async function setTags(tx: Transaction, entryId: string, tagIds: string[]) {
  await tx.delete(entryTag).where(eq(entryTag.entryId, entryId));
  if (tagIds.length > 0) await tx.insert(entryTag).values(tagIds.map((tagId) => ({ entryId, tagId })));
}

export async function setAffectedTeams(tx: Transaction, entryId: string, teamIds: string[]) {
  await tx.delete(entryAffectedTeam).where(eq(entryAffectedTeam.entryId, entryId));
  if (teamIds.length > 0) await tx.insert(entryAffectedTeam).values(teamIds.map((teamId) => ({ entryId, teamId })));
}

export async function setRelations(tx: Transaction, entryId: string, relatedIds: string[]) {
  await tx.delete(entryRelation).where(eq(entryRelation.entryId, entryId));
  if (relatedIds.length > 0) {
    await tx.insert(entryRelation).values(relatedIds.map((relatedEntryId) => ({ entryId, relatedEntryId })));
  }
}

// ---------------------------------------------------------------------------
// Updates and learnings
// ---------------------------------------------------------------------------

/** An update or learning. Imports of old entries may leave the impact empty ("not set"); the form requires it. */
export type LoggedNote = NoteInput | ImportedNoteInput;

/** Publishes an update or a learning immediately. See `LogOptions` for imports. */
export async function createNote(db: Database, actor: Actor, input: LoggedNote, now = new Date(), options: LogOptions = {}) {
  const publishedAt = options.publishedAt ?? now;
  return writeEntry(db, actor, now, async (tx) => {
    await assertActiveTeam(tx, input.teamId);
    await assertTeams(tx, "affectedTeamIds", input.affectedTeamIds);
    await assertActiveTags(tx, input.tagIds);
    await assertPublishedEntries(tx, "relatedIds", input.relatedIds);

    const links = input.links.map((url) => ({ url }));
    const [created] = await tx
      .insert(entry)
      .values({
        type: input.type,
        status: "published",
        title: input.title,
        summary: input.summary,
        body: input.body,
        rationale: input.rationale,
        impact: input.impact,
        teamId: input.teamId,
        authorId: actor.personId,
        links,
        personalDataConfirmedAt: now,
        submittedAt: publishedAt,
        publishedAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: entry.id, number: entry.number });
    if (!created) throw new Error("Could not create the entry");

    await setTags(tx, created.id, input.tagIds);
    await setAffectedTeams(tx, created.id, input.affectedTeamIds);
    await setRelations(tx, created.id, input.relatedIds);
    await tx.insert(entryRevision).values({
      entryId: created.id,
      revision: 1,
      type: input.type,
      title: input.title,
      summary: input.summary,
      body: input.body,
      rationale: input.rationale,
      impact: input.impact,
      teamId: input.teamId,
      tagIds: input.tagIds,
      affectedTeamIds: input.affectedTeamIds,
      links,
      relatedEntryIds: input.relatedIds,
      editedById: actor.personId,
      personalDataConfirmedAt: now,
      createdAt: now,
    });
    if (options.importedFrom) await tx.insert(entryImport).values({ ...options.importedFrom, entryId: created.id, createdAt: now });
    return {
      entryId: created.id,
      audit: { action: "entry.published", payload: { type: input.type } },
      searchText: true,
      post: options.announce !== false,
      webhook: true,
      result: created,
    };
  });
}

/**
 * Saves a corrected update or learning as a new revision; the type can change
 * between the two. Only its author may edit it. Returns the new revision
 * number, or undefined when nothing changed.
 */
export async function editNote(db: Database, actor: Actor, entryId: string, input: NoteInput, now = new Date()) {
  return writeEntry<number | undefined>(db, actor, now, async (tx) => {
    const [current] = await tx.select().from(entry).where(eq(entry.id, entryId)).for("update");
    if (!current || current.type === "decision" || current.status !== "published") {
      throw new EntryError("not_found", "This update or learning does not exist.");
    }
    if (current.authorId !== actor.personId) throw new EntryError("forbidden", "Only the author can edit this entry.");
    if (input.relatedIds.includes(entryId)) throw invalid("relatedIds", "An entry cannot be related to itself.");

    // A team or tag that was deactivated later may stay on the entry.
    if (input.teamId !== current.teamId) await assertActiveTeam(tx, input.teamId);
    await assertTeams(tx, "affectedTeamIds", input.affectedTeamIds);
    const currentTags = await tx.select({ id: entryTag.tagId }).from(entryTag).where(eq(entryTag.entryId, entryId));
    await assertActiveTags(
      tx,
      input.tagIds.filter((tagId) => !currentTags.some((t) => t.id === tagId)),
    );
    await assertPublishedEntries(tx, "relatedIds", input.relatedIds);

    const [latest] = await tx
      .select()
      .from(entryRevision)
      .where(eq(entryRevision.entryId, entryId))
      .orderBy(sql`${entryRevision.revision} desc`)
      .limit(1);
    const links = input.links.map((url) => ({ url }));
    const unchanged =
      latest &&
      latest.type === input.type &&
      latest.title === input.title &&
      latest.summary === input.summary &&
      latest.body === input.body &&
      latest.rationale === input.rationale &&
      current.impact === input.impact &&
      latest.teamId === input.teamId &&
      sameSet(latest.tagIds, input.tagIds) &&
      sameSet(latest.affectedTeamIds, input.affectedTeamIds) &&
      sameSet(latest.relatedEntryIds, input.relatedIds) &&
      JSON.stringify(latest.links) === JSON.stringify(links);
    if (unchanged) return null;

    const revision = (latest?.revision ?? 0) + 1;
    await tx
      .update(entry)
      .set({
        type: input.type,
        title: input.title,
        summary: input.summary,
        body: input.body,
        rationale: input.rationale,
        impact: input.impact,
        teamId: input.teamId,
        links,
        personalDataConfirmedAt: now,
        editedAt: now,
        updatedAt: now,
      })
      .where(eq(entry.id, entryId));
    await setTags(tx, entryId, input.tagIds);
    await setAffectedTeams(tx, entryId, input.affectedTeamIds);
    await setRelations(tx, entryId, input.relatedIds);
    await tx.insert(entryRevision).values({
      entryId,
      revision,
      type: input.type,
      title: input.title,
      summary: input.summary,
      body: input.body,
      rationale: input.rationale,
      impact: input.impact,
      teamId: input.teamId,
      tagIds: input.tagIds,
      affectedTeamIds: input.affectedTeamIds,
      links,
      relatedEntryIds: input.relatedIds,
      editedById: actor.personId,
      personalDataConfirmedAt: now,
      createdAt: now,
    });
    return { entryId, audit: { action: "entry.edited", payload: { revision } }, searchText: true, webhook: true, result: revision };
  });
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

// ---------------------------------------------------------------------------
// Logged decisions
// ---------------------------------------------------------------------------

/**
 * A decision logged directly. Imports of old decisions may leave the impact
 * and the reversibility empty ("not set"); the form requires both.
 */
export type LoggedDecision = DecisionInput | ImportedDecisionInput;

/**
 * Publishes a decision made outside Logbuch. A published
 * decision is never edited; corrections are addenda. If it supersedes another
 * decision, that one is flagged and keeps its status. See `LogOptions` for
 * imports of old decisions.
 */
export async function logDecision(db: Database, actor: Actor, input: LoggedDecision, now = new Date(), options: LogOptions = {}) {
  if (input.decidedOn > serverDate(now)) throw invalid("decidedOn", "The decision date cannot be in the future.");
  const publishedAt = options.publishedAt ?? now;
  return writeEntry(db, actor, now, async (tx) => {
    await assertActiveTeam(tx, input.teamId);
    await assertTeams(tx, "affectedTeamIds", input.affectedTeamIds);
    await assertActiveTags(tx, input.tagIds);
    await assertPeopleWithAccess(tx, "deciderId", [input.deciderId]);
    await assertPeopleWithAccess(tx, "involvedIds", input.involvedIds);
    await assertPublishedEntries(tx, "relatedIds", input.relatedIds);
    if (input.supersedesId) await assertSupersedable(tx, input.supersedesId, { reversibility: input.reversibility, proposal: false });

    const [created] = await tx
      .insert(entry)
      .values({
        type: "decision",
        status: "published",
        title: input.title,
        summary: input.summary,
        body: input.body,
        rationale: input.rationale,
        impact: input.impact,
        teamId: input.teamId,
        authorId: actor.personId,
        links: input.links.map((url) => ({ url })),
        supersedesId: input.supersedesId,
        personalDataConfirmedAt: now,
        submittedAt: publishedAt,
        publishedAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: entry.id, number: entry.number });
    if (!created) throw new Error("Could not create the decision");

    await tx.insert(decision).values({
      entryId: created.id,
      reversibility: input.reversibility,
      reversibilityReason: input.reversibility === "one_way" ? input.reversibilityReason || null : null,
      deciderId: input.deciderId,
      howDecided: input.howDecided,
      effectiveDate: input.effectiveDate ?? null,
      reviewDate: input.reviewDate ?? null,
      updatedAt: now,
    });
    await tx.insert(outcome).values({
      entryId: created.id,
      result: "recorded",
      finalText: input.decisionText,
      decidedById: input.deciderId,
      decidedOn: input.decidedOn,
      personalDataConfirmedAt: now,
      // "Must read" counts from the outcome: for an old decision, its original date.
      createdAt: publishedAt,
    });
    if (input.involvedIds.length > 0) {
      await tx.insert(participant).values(
        input.involvedIds.map((personId) => ({
          entryId: created.id,
          personId,
          role: "involved" as const,
          addedById: actor.personId,
          addedAt: now,
        })),
      );
    }
    await setTags(tx, created.id, input.tagIds);
    await setAffectedTeams(tx, created.id, input.affectedTeamIds);
    await setRelations(tx, created.id, input.relatedIds);
    if (options.importedFrom) await tx.insert(entryImport).values({ ...options.importedFrom, entryId: created.id, createdAt: now });
    if (input.supersedesId) await markSuperseded(tx, actor.personId, input.supersedesId, created.id, now);
    return {
      entryId: created.id,
      audit: { action: "entry.published", payload: { type: "decision", supersedesId: input.supersedesId ?? null } },
      searchText: true,
      post: options.announce !== false,
      webhook: true,
      result: created,
    };
  });
}

// ---------------------------------------------------------------------------
// Impact
// ---------------------------------------------------------------------------

/** Who may change an entry's impact: its author, the decider, or an admin. */
export async function canChangeImpact(db: Database | Transaction, actor: Actor, entryId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: entry.status, authorId: entry.authorId, deciderId: decision.deciderId })
    .from(entry)
    .leftJoin(decision, eq(decision.entryId, entry.id))
    .where(eq(entry.id, entryId));
  // A draft's impact changes in the draft form.
  if (!row || row.status === "draft") return false;
  return actor.isAdmin || row.authorId === actor.personId || row.deciderId === actor.personId;
}

/** Impact classifies an entry and is not part of its content, so it may change after publication. */
export async function changeImpact(db: Database, actor: Actor, entryId: string, impact: Impact, now = new Date()) {
  return writeEntry(db, actor, now, async (tx) => {
    const [current] = await tx.select({ impact: entry.impact }).from(entry).where(eq(entry.id, entryId)).for("update");
    if (!current) throw new EntryError("not_found", "This entry does not exist.");
    if (!(await canChangeImpact(tx, actor, entryId))) {
      throw new EntryError("forbidden", "Only the author, the decider, or an admin can change the impact.");
    }
    if (current.impact === impact) return null;
    await tx.update(entry).set({ impact, updatedAt: now }).where(eq(entry.id, entryId));
    return { entryId, audit: { action: "entry.impact_changed", payload: { from: current.impact, to: impact } }, webhook: true };
  });
}

// ---------------------------------------------------------------------------
// Addenda and superseding
// ---------------------------------------------------------------------------

/** Who may add an addendum to a published decision: the decider, the author, or an admin. */
export async function canAddAddendum(db: Database | Transaction, actor: Actor, entryId: string): Promise<boolean> {
  const [row] = await db
    .select({ type: entry.type, status: entry.status, authorId: entry.authorId, deciderId: decision.deciderId })
    .from(entry)
    .leftJoin(decision, eq(decision.entryId, entry.id))
    .where(eq(entry.id, entryId));
  if (!row || row.type !== "decision" || !(DECIDED_STATUSES as readonly string[]).includes(row.status)) return false;
  return actor.isAdmin || row.authorId === actor.personId || row.deciderId === actor.personId;
}

/**
 * Checks that `targetId` is a decision in force that the new decision may
 * replace: a two-way decision, or one whose reversibility
 * is not set, by any decision; a one-way decision only through a one-way
 * proposal. Locks the target row.
 */
export async function assertSupersedable(
  tx: Transaction,
  targetId: string,
  replacement: { reversibility: Reversibility | null; proposal: boolean },
): Promise<void> {
  const [target] = await tx
    .select({ type: entry.type, status: entry.status, supersededById: entry.supersededById, reversibility: decision.reversibility })
    .from(entry)
    .leftJoin(decision, eq(decision.entryId, entry.id))
    .where(eq(entry.id, targetId))
    .for("update", { of: entry });
  if (!target || target.type !== "decision" || !(DECIDED_STATUSES as readonly string[]).includes(target.status)) {
    throw invalid("supersedesId", "Choose a decision.");
  }
  if (target.supersededById) throw invalid("supersedesId", "This decision has already been replaced.");
  if (target.reversibility === "one_way" && !(replacement.proposal && replacement.reversibility === "one_way")) {
    throw invalid("supersedesId", "A one-way decision can only be replaced through a one-way proposal.");
  }
}

/** Flags the replaced decision; it keeps its status. */
export async function markSuperseded(tx: Transaction, actorId: string, targetId: string, replacementId: string, now: Date) {
  await tx
    .update(entry)
    .set({ supersededById: replacementId, updatedAt: now })
    .where(and(eq(entry.id, targetId), isNull(entry.supersededById)));
  await recordAudit(tx, { actorId, action: "entry.superseded", entryId: targetId, payload: { supersededById: replacementId } });
  // The webhook sends the replaced entry again, no longer in force.
  await requestWebhook(tx, targetId, now);
}

export async function addAddendum(db: Database, actor: Actor, entryId: string, input: AddendumInput, now = new Date()) {
  return writeEntry(db, actor, now, async (tx) => {
    const [target] = await tx.select({ id: entry.id }).from(entry).where(eq(entry.id, entryId)).for("update");
    if (!target) throw new EntryError("not_found", "This entry does not exist.");
    if (!(await canAddAddendum(tx, actor, entryId))) {
      throw new EntryError("forbidden", "Only the decider, the author, or an admin can add an addendum.");
    }
    const [created] = await tx
      .insert(addendum)
      .values({ entryId, authorId: actor.personId, text: input.text, personalDataConfirmedAt: now, createdAt: now })
      .returning({ id: addendum.id });
    await tx.update(entry).set({ updatedAt: now }).where(eq(entry.id, entryId));
    if (!created) throw new Error("Could not record the addendum");
    return {
      entryId,
      audit: { action: "entry.addendum_added", payload: { addendumId: created.id } },
      searchText: true,
      addendumId: created.id,
      webhook: true,
      result: created,
    };
  });
}

// ---------------------------------------------------------------------------
// Tags (admins)
// ---------------------------------------------------------------------------

function assertAdmin(actor: Actor) {
  if (!actor.isAdmin) throw new EntryError("forbidden", "Only admins can manage tags.");
}

async function assertUniqueTagName(tx: Transaction, name: string, exceptId?: string) {
  const [existing] = await tx
    .select({ id: tag.id })
    .from(tag)
    .where(sql`lower(${tag.name}) = lower(${name})`);
  if (existing && existing.id !== exceptId) throw invalid("name", "A tag with this name already exists.");
}

export async function createTag(db: Database, actor: Actor, input: TagInput) {
  assertAdmin(actor);
  return db.transaction(async (tx) => {
    await assertUniqueTagName(tx, input.name);
    const [created] = await tx.insert(tag).values({ name: input.name }).returning({ id: tag.id });
    await recordAudit(tx, { actorId: actor.personId, action: "tag.created", payload: { tagId: created?.id, name: input.name } });
    return created;
  });
}

export async function renameTag(db: Database, actor: Actor, tagId: string, input: TagInput) {
  assertAdmin(actor);
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(tag).where(eq(tag.id, tagId)).for("update");
    if (!current) throw new EntryError("not_found", "This tag does not exist.");
    if (current.name === input.name) return;
    await assertUniqueTagName(tx, input.name, tagId);
    await tx.update(tag).set({ name: input.name, updatedAt: new Date() }).where(eq(tag.id, tagId));
    await recordAudit(tx, { actorId: actor.personId, action: "tag.renamed", payload: { tagId, from: current.name, to: input.name } });
  });
}

/** Tags are never deleted; an inactive tag stays on old entries but cannot be chosen. */
export async function setTagActive(db: Database, actor: Actor, tagId: string, isActive: boolean) {
  assertAdmin(actor);
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(tag).where(eq(tag.id, tagId)).for("update");
    if (!current) throw new EntryError("not_found", "This tag does not exist.");
    if (current.isActive === isActive) return;
    await tx.update(tag).set({ isActive, updatedAt: new Date() }).where(eq(tag.id, tagId));
    await recordAudit(tx, {
      actorId: actor.personId,
      action: isActive ? "tag.activated" : "tag.deactivated",
      payload: { tagId, name: current.name },
    });
  });
}
