import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Database } from "@/lib/db/client";
import { SERVER_TIME_ZONE } from "@/lib/format";
import {
  addendum,
  auditEvent,
  decision,
  entry,
  entryAffectedTeam,
  entryRelation,
  entryRevision,
  entryTag,
  outcome,
  participant,
  person,
  proposal,
  tag,
  team,
} from "@/lib/db/schema";
import { ENTRY_TYPES, HOW_DECIDED, IMPACTS, MUST_READ_DAYS, REVERSIBILITIES } from "./constants";
import { parseEntryRef } from "./refs";
import { searchTsQuery } from "./search";

// ---------------------------------------------------------------------------
// Form options
// ---------------------------------------------------------------------------

export interface Option {
  id: string;
  label: string;
  hint?: string;
}

/** Choices for the entry forms: active teams and tags, and people with access. */
export async function getFormOptions(db: Database) {
  const [teams, tags, people] = await Promise.all([
    db.select({ id: team.id, label: team.name }).from(team).where(eq(team.isActive, true)).orderBy(asc(team.name)),
    db.select({ id: tag.id, label: tag.name }).from(tag).where(eq(tag.isActive, true)).orderBy(asc(tag.name)),
    db
      .select({ id: person.id, label: person.displayName, hint: team.name })
      .from(person)
      .leftJoin(team, eq(team.id, person.teamId))
      .where(eq(person.hasAccess, true))
      .orderBy(asc(person.displayName)),
  ]);
  return {
    teams: teams satisfies Option[],
    tags: tags satisfies Option[],
    people: people.map((p) => ({ id: p.id, label: p.label, hint: p.hint ?? undefined })) satisfies Option[],
  };
}

/** Everyone who ever appeared in Logbuch, for the timeline's person filter. */
export async function getFilterOptions(db: Database) {
  const [teams, tags, people] = await Promise.all([
    db.select({ id: team.id, label: team.name }).from(team).orderBy(asc(team.name)),
    db.select({ id: tag.id, label: tag.name }).from(tag).orderBy(asc(tag.name)),
    db.select({ id: person.id, label: person.displayName }).from(person).orderBy(asc(person.displayName)),
  ]);
  return { teams, tags, people };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));
const optionalUuid = optionalString.pipe(z.uuid().optional().catch(undefined));
const optionalDate = optionalString.pipe(z.iso.date().optional().catch(undefined));

export const timelineFiltersSchema = z.object({
  q: optionalString.pipe(z.string().max(200).optional().catch(undefined)),
  type: optionalString.pipe(z.enum(ENTRY_TYPES).optional().catch(undefined)),
  status: optionalString.pipe(z.enum(["open", "decided", "rejected", "withdrawn"]).optional().catch(undefined)),
  impact: optionalString.pipe(z.enum(IMPACTS).optional().catch(undefined)),
  reversibility: optionalString.pipe(z.enum(REVERSIBILITIES).optional().catch(undefined)),
  how: optionalString.pipe(z.enum(HOW_DECIDED).optional().catch(undefined)),
  team: optionalUuid,
  affected: optionalUuid,
  tag: optionalUuid,
  person: optionalUuid,
  from: optionalDate,
  to: optionalDate,
  page: optionalString.pipe(z.coerce.number<string | undefined>().int().min(1).max(1000).optional()).catch(undefined),
});

export type TimelineFilters = z.infer<typeof timelineFiltersSchema>;

/** Reads the filters from URL search parameters; invalid values are ignored. */
export function parseTimelineFilters(params: Record<string, string | string[] | undefined>): TimelineFilters {
  const flat = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  return timelineFiltersSchema.parse(flat);
}

export const TIMELINE_PAGE_SIZE = 25;

/**
 * The words of a search (see searchTsQuery), with English stemming and,
 * for every other language, without; undefined without words.
 */
function textQuery(q: string): SQL | undefined {
  const query = searchTsQuery(q);
  return query ? sql`(to_tsquery('english', ${query}) || to_tsquery('simple', ${query}))` : undefined;
}

/** Matches entries by number (LB-12) or by their words. */
function searchCondition(q: string): SQL {
  const number = parseEntryRef(q);
  const text = textQuery(q);
  return or(number ? eq(entry.number, number) : undefined, text ? sql`${entry.searchVector} @@ ${text}` : undefined) ?? sql`false`;
}

/** The timeline's status filter. "Decided" covers decided proposals and logged decisions. */
const statusCondition = (status: NonNullable<TimelineFilters["status"]>): SQL => {
  switch (status) {
    case "open":
      return inArray(entry.status, ["feedback", "objection_round"]);
    case "decided":
      return or(eq(entry.status, "decided"), and(eq(entry.type, "decision"), eq(entry.status, "published")))!;
    default:
      return eq(entry.status, status);
  }
};

/**
 * Large entries published in the last MUST_READ_DAYS days come first, unless
 * they are no longer in force: rejected, withdrawn, or
 * replaced. A decided proposal counts from its decision, not its submission.
 * Never NULL, which would sort first. Needs the outcome joined.
 */
/** Imported from an earlier log: it shows its original date, without a time. */
const imported = sql<boolean>`exists (select 1 from entry_import ei where ei.entry_id = ${entry.id})`;

const pinned = sql<boolean>`coalesce(
  ${entry.impact} = 'large'
    and coalesce(${outcome.createdAt}, ${entry.publishedAt}) >= now() - make_interval(days => ${MUST_READ_DAYS})
    and ${entry.status} not in ('rejected', 'withdrawn')
    and ${entry.supersededById} is null,
  false)`;

/**
 * Updates, decisions, learnings, and proposals (open and closed), newest
 * first, with recent Large entries on top. Drafts never
 * appear; they are private to the proposer.
 */
export async function listTimeline(db: Database, filters: TimelineFilters) {
  const conditions: SQL[] = [ne(entry.status, "draft")];
  if (filters.type) conditions.push(eq(entry.type, filters.type));
  if (filters.status) conditions.push(statusCondition(filters.status));
  if (filters.impact) conditions.push(eq(entry.impact, filters.impact));
  if (filters.reversibility) conditions.push(eq(decision.reversibility, filters.reversibility));
  if (filters.how) conditions.push(eq(decision.howDecided, filters.how));
  if (filters.team) conditions.push(eq(entry.teamId, filters.team));
  if (filters.affected) {
    conditions.push(sql`exists (select 1 from entry_affected_team eat where eat.entry_id = ${entry.id} and eat.team_id = ${filters.affected})`);
  }
  if (filters.tag) {
    conditions.push(sql`exists (select 1 from entry_tag et where et.entry_id = ${entry.id} and et.tag_id = ${filters.tag})`);
  }
  if (filters.person) {
    conditions.push(
      or(
        eq(entry.authorId, filters.person),
        eq(decision.deciderId, filters.person),
        sql`exists (select 1 from outcome o where o.entry_id = ${entry.id} and o.decided_by_id = ${filters.person})`,
        sql`exists (select 1 from participant p where p.entry_id = ${entry.id} and p.person_id = ${filters.person} and p.removed_at is null)`,
      )!,
    );
  }
  // Dates are calendar days in the server's time zone.
  if (filters.from) conditions.push(sql`${entry.publishedAt} >= (${filters.from}::date)::timestamp at time zone ${SERVER_TIME_ZONE}`);
  if (filters.to) conditions.push(sql`${entry.publishedAt} < (${filters.to}::date + 1)::timestamp at time zone ${SERVER_TIME_ZONE}`);
  if (filters.q) conditions.push(searchCondition(filters.q));

  const page = filters.page ?? 1;
  const decider = alias(person, "decider");
  const rows = await db
    .select({
      id: entry.id,
      number: entry.number,
      type: entry.type,
      title: entry.title,
      summary: entry.summary,
      impact: entry.impact,
      pinned,
      imported,
      publishedAt: entry.publishedAt,
      editedAt: entry.editedAt,
      supersededById: entry.supersededById,
      teamName: team.name,
      authorName: person.displayName,
      status: entry.status,
      isProposal: sql<boolean>`${proposal.entryId} is not null`,
      decidedOn: outcome.decidedOn,
      deciderName: decider.displayName,
      reversibility: decision.reversibility,
      feedbackDeadline: proposal.feedbackDeadline,
      objectionDeadline: proposal.objectionDeadline,
    })
    .from(entry)
    .innerJoin(team, eq(team.id, entry.teamId))
    .innerJoin(person, eq(person.id, entry.authorId))
    .leftJoin(outcome, eq(outcome.entryId, entry.id))
    .leftJoin(decision, eq(decision.entryId, entry.id))
    .leftJoin(decider, eq(decider.id, decision.deciderId))
    .leftJoin(proposal, eq(proposal.entryId, entry.id))
    .where(and(...conditions))
    .orderBy(desc(pinned), desc(entry.publishedAt), desc(entry.number))
    .limit(TIMELINE_PAGE_SIZE + 1)
    .offset((page - 1) * TIMELINE_PAGE_SIZE);

  const items = rows.slice(0, TIMELINE_PAGE_SIZE);
  const ids = items.map((item) => item.id);
  const [tagsByEntry, affectedByEntry] = await Promise.all([tagsForEntries(db, ids), affectedTeamsForEntries(db, ids)]);
  return {
    items: items.map((item) => ({ ...item, tags: tagsByEntry.get(item.id) ?? [], affectedTeams: affectedByEntry.get(item.id) ?? [] })),
    page,
    hasMore: rows.length > TIMELINE_PAGE_SIZE,
  };
}

export type TimelineItem = Awaited<ReturnType<typeof listTimeline>>["items"][number];

async function affectedTeamsForEntries(db: Database, entryIds: string[]) {
  const map = new Map<string, string[]>();
  if (entryIds.length === 0) return map;
  const rows = await db
    .select({ entryId: entryAffectedTeam.entryId, name: team.name })
    .from(entryAffectedTeam)
    .innerJoin(team, eq(team.id, entryAffectedTeam.teamId))
    .where(inArray(entryAffectedTeam.entryId, entryIds))
    .orderBy(asc(team.name));
  for (const row of rows) map.set(row.entryId, [...(map.get(row.entryId) ?? []), row.name]);
  return map;
}

async function tagsForEntries(db: Database, entryIds: string[]) {
  const map = new Map<string, string[]>();
  if (entryIds.length === 0) return map;
  const rows = await db
    .select({ entryId: entryTag.entryId, name: tag.name })
    .from(entryTag)
    .innerJoin(tag, eq(tag.id, entryTag.tagId))
    .where(inArray(entryTag.entryId, entryIds))
    .orderBy(asc(tag.name));
  for (const row of rows) map.set(row.entryId, [...(map.get(row.entryId) ?? []), row.name]);
  return map;
}

// ---------------------------------------------------------------------------
// Entry detail
// ---------------------------------------------------------------------------

/** An entry by its LB number. Drafts are only returned to their author. */
export async function getEntryByNumber(db: Database, number: number, viewerId?: string) {
  const [row] = await db
    .select({
      entry,
      teamName: team.name,
      authorName: person.displayName,
      imported,
    })
    .from(entry)
    .innerJoin(team, eq(team.id, entry.teamId))
    .innerJoin(person, eq(person.id, entry.authorId))
    .where(eq(entry.number, number));
  if (!row) return undefined;
  const e = row.entry;
  if (e.status === "draft" && e.authorId !== viewerId) return undefined;

  const decider = alias(person, "decider");
  const decidedBy = alias(person, "decided_by");
  const supersedes = alias(entry, "supersedes");
  const supersededBy = alias(entry, "superseded_by");
  const [tags, affectedTeams, related, [decisionRow], [outcomeRow], [proposalRow], involved, addenda, [links]] = await Promise.all([
    db
      .select({ id: tag.id, name: tag.name })
      .from(entryTag)
      .innerJoin(tag, eq(tag.id, entryTag.tagId))
      .where(eq(entryTag.entryId, e.id))
      .orderBy(asc(tag.name)),
    db
      .select({ id: team.id, name: team.name })
      .from(entryAffectedTeam)
      .innerJoin(team, eq(team.id, entryAffectedTeam.teamId))
      .where(eq(entryAffectedTeam.entryId, e.id))
      .orderBy(asc(team.name)),
    db
      .select({ id: entry.id, number: entry.number, title: entry.title, type: entry.type })
      .from(entryRelation)
      .innerJoin(entry, eq(entry.id, entryRelation.relatedEntryId))
      .where(eq(entryRelation.entryId, e.id))
      .orderBy(desc(entry.number)),
    db
      .select({ decision, deciderName: decider.displayName })
      .from(decision)
      .innerJoin(decider, eq(decider.id, decision.deciderId))
      .where(eq(decision.entryId, e.id)),
    db
      .select({ outcome, decidedByName: decidedBy.displayName })
      .from(outcome)
      .innerJoin(decidedBy, eq(decidedBy.id, outcome.decidedById))
      .where(eq(outcome.entryId, e.id)),
    db.select({ entryId: proposal.entryId }).from(proposal).where(eq(proposal.entryId, e.id)),
    db
      .select({ id: person.id, name: person.displayName })
      .from(participant)
      .innerJoin(person, eq(person.id, participant.personId))
      .where(and(eq(participant.entryId, e.id), eq(participant.role, "involved"), isNull(participant.removedAt)))
      .orderBy(asc(person.displayName)),
    db
      .select({ id: addendum.id, text: addendum.text, createdAt: addendum.createdAt, authorName: person.displayName })
      .from(addendum)
      .innerJoin(person, eq(person.id, addendum.authorId))
      .where(eq(addendum.entryId, e.id))
      .orderBy(asc(addendum.createdAt)),
    db
      .select({
        supersedesNumber: supersedes.number,
        supersedesTitle: supersedes.title,
        supersededByNumber: supersededBy.number,
        supersededByTitle: supersededBy.title,
      })
      .from(entry)
      .leftJoin(supersedes, eq(supersedes.id, entry.supersedesId))
      .leftJoin(supersededBy, eq(supersededBy.id, entry.supersededById))
      .where(eq(entry.id, e.id)),
  ]);

  return {
    ...e,
    teamName: row.teamName,
    authorName: row.authorName,
    imported: row.imported,
    tags,
    affectedTeams,
    related,
    /** The decision process ran (or runs) for this entry. */
    isProposal: proposalRow !== undefined,
    decision: decisionRow ? { ...decisionRow.decision, deciderName: decisionRow.deciderName } : undefined,
    outcome: outcomeRow ? { ...outcomeRow.outcome, decidedByName: outcomeRow.decidedByName } : undefined,
    involved,
    addenda,
    supersedes: links?.supersedesNumber ? { number: links.supersedesNumber, title: links.supersedesTitle! } : undefined,
    supersededBy: links?.supersededByNumber
      ? { number: links.supersededByNumber, title: links.supersededByTitle! }
      : undefined,
  };
}

export type EntryDetail = NonNullable<Awaited<ReturnType<typeof getEntryByNumber>>>;

/** Current values of an update or learning, for its edit form. */
export async function getNoteFormValues(db: Database, entryId: string) {
  const [[current], tags, affectedTeams, related] = await Promise.all([
    db.select().from(entry).where(eq(entry.id, entryId)),
    db.select({ id: entryTag.tagId }).from(entryTag).where(eq(entryTag.entryId, entryId)),
    db.select({ id: entryAffectedTeam.teamId }).from(entryAffectedTeam).where(eq(entryAffectedTeam.entryId, entryId)),
    db
      .select({ id: entry.id, number: entry.number, title: entry.title })
      .from(entryRelation)
      .innerJoin(entry, eq(entry.id, entryRelation.relatedEntryId))
      .where(eq(entryRelation.entryId, entryId)),
  ]);
  if (!current || current.type === "decision") return undefined;
  return {
    type: current.type,
    title: current.title,
    teamId: current.teamId,
    tagIds: tags.map((t) => t.id),
    affectedTeamIds: affectedTeams.map((t) => t.id),
    summary: current.summary,
    body: current.body,
    rationale: current.rationale,
    impact: current.impact ?? undefined,
    links: current.links.map((link) => link.url),
    related,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Revisions of an update or learning (oldest first) and the entry's audit log. */
export async function getEntryHistory(db: Database, entryId: string) {
  const editor = alias(person, "editor");
  const actor = alias(person, "actor");
  const [revisions, events, teams, tags, related] = await Promise.all([
    db
      .select({ revision: entryRevision, editorName: editor.displayName })
      .from(entryRevision)
      .innerJoin(editor, eq(editor.id, entryRevision.editedById))
      .where(eq(entryRevision.entryId, entryId))
      .orderBy(asc(entryRevision.revision)),
    db
      .select({ id: auditEvent.id, action: auditEvent.action, payload: auditEvent.payload, createdAt: auditEvent.createdAt, actorName: actor.displayName })
      .from(auditEvent)
      .leftJoin(actor, eq(actor.id, auditEvent.actorId))
      .where(eq(auditEvent.entryId, entryId))
      .orderBy(asc(auditEvent.createdAt), asc(auditEvent.id)),
    db.select({ id: team.id, name: team.name }).from(team),
    db.select({ id: tag.id, name: tag.name }).from(tag),
    db.select({ id: entry.id, number: entry.number }).from(entry),
  ]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const entryNumber = new Map(related.map((r) => [r.id, r.number]));
  return {
    revisions: revisions.map(({ revision, editorName }) => ({
      ...revision,
      editorName,
      teamName: teamName.get(revision.teamId) ?? "",
      tagNames: revision.tagIds.map((id) => tagName.get(id) ?? "").filter(Boolean).sort(),
      affectedTeamNames: revision.affectedTeamIds.map((id) => teamName.get(id) ?? "").filter(Boolean).sort(),
      relatedNumbers: revision.relatedEntryIds.map((id) => entryNumber.get(id)).filter((n): n is number => n !== undefined),
    })),
    events,
  };
}

// ---------------------------------------------------------------------------
// Entry picker, search, and tags
// ---------------------------------------------------------------------------

/**
 * Entries for the "Related entries" and "Supersedes" pickers: published
 * updates, learnings, and decisions, and decided proposals. `supersedable`
 * limits results to decisions that are not replaced yet.
 */
export async function searchEntriesForPicker(
  db: Database,
  options: { q: string; supersedable?: boolean; excludeId?: string; limit?: number },
) {
  const conditions: SQL[] = [inArray(entry.status, ["published", "decided"])];
  if (options.q.trim()) conditions.push(searchCondition(options.q.trim()));
  if (options.supersedable) conditions.push(eq(entry.type, "decision"), isNull(entry.supersededById));
  if (options.excludeId) conditions.push(sql`${entry.id} <> ${options.excludeId}`);
  return db
    .select({ id: entry.id, number: entry.number, title: entry.title, type: entry.type })
    .from(entry)
    .where(and(...conditions))
    .orderBy(desc(entry.publishedAt))
    .limit(options.limit ?? 20);
}

/**
 * The search in the sidebar (⌘K): entries the timeline shows, best match
 * first. The entry whose number was typed comes first, then matches in the
 * title before the summary and the text, then the newest.
 */
export async function searchEntries(db: Database, q: string, limit = 8) {
  const query = q.trim();
  const number = parseEntryRef(query);
  const text = textQuery(query);
  const order: SQL[] = [];
  if (number) order.push(sql`${entry.number} = ${number} desc`);
  if (text) order.push(sql`ts_rank(${entry.searchVector}, ${text}) desc`);
  return db
    .select({
      number: entry.number,
      title: entry.title,
      type: entry.type,
      status: entry.status,
      isProposal: sql<boolean>`${proposal.entryId} is not null`,
    })
    .from(entry)
    .leftJoin(proposal, eq(proposal.entryId, entry.id))
    .where(and(ne(entry.status, "draft"), searchCondition(query)))
    .orderBy(...order, desc(entry.publishedAt))
    .limit(limit);
}

/** All tags with the number of entries that use them, for the admin page. */
export async function listTagsWithUsage(db: Database) {
  return db
    .select({ id: tag.id, name: tag.name, isActive: tag.isActive, entries: count(entryTag.entryId) })
    .from(tag)
    .leftJoin(entryTag, eq(entryTag.tagId, tag.id))
    .groupBy(tag.id)
    .orderBy(asc(tag.name));
}
