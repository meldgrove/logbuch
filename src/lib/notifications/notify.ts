import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { isWorkingDay } from "@/lib/calendar";
import type { Database, Transaction } from "@/lib/db/client";
import { decision, entry, entryAffectedTeam, notificationDelivery, participant, person, proposal, team } from "@/lib/db/schema";
import { serverDate, serverHour } from "@/lib/format";
import { loadProposal, type LoadedProposal } from "@/lib/process/snapshot";
import {
  planAddendum,
  planEntryPost,
  planLostAccess,
  planProposalEvent,
  planReminders,
  planReviewReminder,
  type LostAccessRow,
  type PlannedDelivery,
  type PostInfo,
  type ProposalEvent,
} from "./plan";

/*
 * Records notifications as `notification_delivery` rows. Commands call these
 * functions inside their transaction, so a notification exists exactly when
 * its write does. They only load facts: who gets which message is decided in
 * plan.ts. The worker sends the rows; nothing is sent here.
 */

type Db = Database | Transaction;

/** Reminder emails go out from 09:00 in the server's time zone. */
export const REMINDER_HOUR = 9;

/**
 * Inserts the planned deliveries for people with access, and channel posts
 * (no recipient). A known delivery key is ignored.
 */
export async function enqueue(db: Db, planned: PlannedDelivery[], now: Date): Promise<number> {
  if (planned.length === 0) return 0;
  const ids = [...new Set(planned.map((p) => p.recipientId).filter((id): id is string => id !== null))];
  const withAccess = new Set(
    ids.length === 0
      ? []
      : (await db.select({ id: person.id }).from(person).where(and(inArray(person.id, ids), eq(person.hasAccess, true)))).map((p) => p.id),
  );
  const values = planned
    .filter((p) => p.recipientId === null || withAccess.has(p.recipientId))
    .map((p) => ({
      deliveryKey: p.key,
      event: p.event,
      entryId: p.entryId,
      recipientId: p.recipientId,
      channel: p.channel,
      message: p.message,
      createdAt: now,
      nextAttemptAt: now,
    }));
  if (values.length === 0) return 0;
  const inserted = await db
    .insert(notificationDelivery)
    .values(values)
    .onConflictDoNothing({ target: notificationDelivery.deliveryKey })
    .returning({ id: notificationDelivery.id });
  return inserted.length;
}

async function nameOf(db: Db, personId: string): Promise<string> {
  const [row] = await db.select({ name: person.displayName }).from(person).where(eq(person.id, personId));
  return row?.name ?? "Someone";
}

const entryInfo = (loaded: LoadedProposal) => ({ id: loaded.entry.id, number: loaded.entry.number, title: loaded.entry.title });

async function affectedTeamNames(db: Db, entryId: string): Promise<string[]> {
  const rows = await db
    .select({ name: team.name })
    .from(entryAffectedTeam)
    .innerJoin(team, eq(team.id, entryAffectedTeam.teamId))
    .where(eq(entryAffectedTeam.entryId, entryId))
    .orderBy(asc(team.name));
  return rows.map((row) => row.name);
}

/** What the channel post of an entry says, as of now. */
async function postInfo(db: Db, row: { id: string; type: PostInfo["type"]; summary: string; impact: PostInfo["impact"] }): Promise<PostInfo> {
  return { type: row.type, summary: row.summary, impact: row.impact, affectedTeams: await affectedTeamNames(db, row.id) };
}

/** Records the channel post for a published update, learning, or logged decision. */
export async function notifyEntryPost(db: Db, entryId: string, actorId: string, now: Date): Promise<void> {
  const [row] = await db
    .select({ id: entry.id, number: entry.number, title: entry.title, type: entry.type, summary: entry.summary, impact: entry.impact })
    .from(entry)
    .where(eq(entry.id, entryId));
  if (!row) return;
  await enqueue(db, [planEntryPost(row, await postInfo(db, row), await nameOf(db, actorId))], now);
}

/**
 * Records the Slack messages for events on a proposal. `loaded` is the state
 * after the write: the planner reads it to choose recipients and wording.
 */
export async function notifyProposal(
  db: Db,
  loaded: LoadedProposal,
  actorId: string | null,
  events: ProposalEvent[],
  now: Date,
): Promise<void> {
  if (events.length === 0) return;
  const actor = actorId ? { personId: actorId, name: await nameOf(db, actorId) } : null;
  const ctx = { entry: entryInfo(loaded), s: loaded.snapshot, actor, post: await postInfo(db, loaded.entry) };
  await enqueue(
    db,
    events.flatMap((event) => planProposalEvent(ctx, event)),
    now,
  );
}

/** Records the Slack messages for a new addendum. */
export async function notifyAddendum(db: Db, entryId: string, addendumId: string, actorId: string, now: Date): Promise<void> {
  const [target] = await db
    .select({ id: entry.id, number: entry.number, title: entry.title, authorId: entry.authorId, deciderId: decision.deciderId })
    .from(entry)
    .leftJoin(decision, eq(decision.entryId, entry.id))
    .where(eq(entry.id, entryId));
  if (!target) return;
  const listed = await db
    .select({ personId: participant.personId })
    .from(participant)
    .where(and(eq(participant.entryId, entryId), isNull(participant.removedAt)));
  const actor = { personId: actorId, name: await nameOf(db, actorId) };
  const facts = { authorId: target.authorId, deciderId: target.deciderId, listedIds: listed.map((p) => p.personId) };
  await enqueue(db, planAddendum(target, addendumId, actor, facts), now);
}

const OPEN_STATUSES = ["feedback", "objection_round"] as const;

async function openProposalIds(db: Db, statuses: readonly ("feedback" | "objection_round")[] = OPEN_STATUSES): Promise<string[]> {
  const rows = await db
    .select({ id: entry.id })
    .from(entry)
    .innerJoin(proposal, eq(proposal.entryId, entry.id))
    .where(inArray(entry.status, [...statuses]))
    .orderBy(asc(entry.number));
  return rows.map((r) => r.id);
}

/** The open proposals in the objection round, which may become ready as time passes. */
export async function proposalsInObjectionRound(db: Db): Promise<string[]> {
  return openProposalIds(db, ["objection_round"]);
}

/**
 * Tells proposers about people without access who are still the decider or
 * listed on an open proposal. Runs every few minutes in the worker; delivery
 * keys make repeated runs harmless.
 */
export async function notifyLostAccess(db: Database, now: Date): Promise<number> {
  const columns = {
    entryId: entry.id,
    number: entry.number,
    title: entry.title,
    proposerId: entry.authorId,
    personId: person.id,
    name: person.displayName,
    since: person.accessChangedAt,
  };
  const listed = await db
    .select({ ...columns, role: participant.role })
    .from(participant)
    .innerJoin(entry, eq(entry.id, participant.entryId))
    .innerJoin(person, eq(person.id, participant.personId))
    .where(
      and(
        isNull(participant.removedAt),
        inArray(participant.role, ["consent_giver", "feedback_giver"]),
        inArray(entry.status, [...OPEN_STATUSES]),
        eq(person.hasAccess, false),
      ),
    );
  const deciders = await db
    .select(columns)
    .from(proposal)
    .innerJoin(entry, eq(entry.id, proposal.entryId))
    .innerJoin(decision, eq(decision.entryId, proposal.entryId))
    .innerJoin(person, eq(person.id, decision.deciderId))
    .where(and(inArray(entry.status, [...OPEN_STATUSES]), eq(person.hasAccess, false)));
  const rows = [...deciders.map((d) => ({ ...d, role: "decider" as const })), ...listed].map(
    ({ entryId, number, title, ...row }): LostAccessRow => ({ ...row, entry: { id: entryId, number, title }, role: row.role as LostAccessRow["role"] }),
  );
  return enqueue(db, planLostAccess(rows), now);
}

/**
 * Records the reminder emails due today. Runs at 09:00 on working days; a run
 * before 09:00 or on a weekend or holiday does nothing. Returns the number of
 * new deliveries.
 */
export async function recordReminders(db: Database, now: Date): Promise<number> {
  const today = serverDate(now);
  if (!isWorkingDay(today) || serverHour(now) < REMINDER_HOUR) return 0;
  let count = 0;
  for (const id of await openProposalIds(db)) {
    const loaded = await loadProposal(db, id);
    if (!loaded) continue;
    const planned = planReminders({ entry: entryInfo(loaded), s: loaded.snapshot, today, now, readySince: loaded.proposal.readySince });
    count += await enqueue(db, planned, now);
  }

  // Decisions whose review date has come; the planner keeps those in force.
  // The delivery key sends each reminder once, also when a decision was
  // published late.
  const reviews = await db
    .select({
      id: entry.id,
      number: entry.number,
      title: entry.title,
      status: entry.status,
      supersededById: entry.supersededById,
      authorId: entry.authorId,
      deciderId: decision.deciderId,
      reviewDate: decision.reviewDate,
    })
    .from(decision)
    .innerJoin(entry, eq(entry.id, decision.entryId))
    .where(and(isNotNull(decision.reviewDate), lte(decision.reviewDate, today)));
  for (const { id, number, title, reviewDate, ...review } of reviews) {
    count += await enqueue(db, planReviewReminder({ ...review, entry: { id, number, title }, reviewDate: reviewDate!, today }), now);
  }
  return count;
}
