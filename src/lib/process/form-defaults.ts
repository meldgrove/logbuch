import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { decision, entry, entryAffectedTeam, entryRelation, entryTag, participant, proposal, proposalVersion } from "@/lib/db/schema";
import { formatEntryRef } from "@/lib/entries/refs";
import { SUMMARY_MAX } from "@/lib/entries/constants";
import { clipText, serverDate } from "@/lib/format";
import { defaultFeedbackDeadline, MINIMUM_PERIODS, minimumFeedbackDeadline, type Reversibility } from "./rules";
import { getDefaultPeriods } from "./settings";

/** Default and minimum deadlines for two-way and one-way, if submitted today. */
export async function periodDefaults(db: Database, now = new Date()) {
  const periods = await getDefaultPeriods(db);
  const today = serverDate(now);
  const forReversibility = (reversibility: Reversibility) => ({
    feedbackDeadline: defaultFeedbackDeadline(reversibility, periods, today),
    minimumFeedbackDeadline: minimumFeedbackDeadline(reversibility, today),
    objectionPeriodDays: Math.max(periods[reversibility].objection, MINIMUM_PERIODS[reversibility].objection),
    minimumObjectionPeriodDays: MINIMUM_PERIODS[reversibility].objection,
  });
  return { two_way: forReversibility("two_way"), one_way: forReversibility("one_way") };
}

/** The saved values of a draft, for its edit form. */
export async function getDraftFormValues(db: Database, entryId: string) {
  const [[row], [version], people, teams, tags, related] = await Promise.all([
    db
      .select({ entry, proposal, decision })
      .from(entry)
      .innerJoin(proposal, eq(proposal.entryId, entry.id))
      .innerJoin(decision, eq(decision.entryId, entry.id))
      .where(eq(entry.id, entryId)),
    db
      .select({ text: proposalVersion.text })
      .from(proposalVersion)
      .where(and(eq(proposalVersion.entryId, entryId), eq(proposalVersion.number, 1))),
    db.select({ personId: participant.personId, role: participant.role }).from(participant).where(eq(participant.entryId, entryId)),
    db.select({ id: entryAffectedTeam.teamId }).from(entryAffectedTeam).where(eq(entryAffectedTeam.entryId, entryId)),
    db.select({ id: entryTag.tagId }).from(entryTag).where(eq(entryTag.entryId, entryId)),
    db
      .select({ id: entry.id, number: entry.number, title: entry.title })
      .from(entryRelation)
      .innerJoin(entry, eq(entry.id, entryRelation.relatedEntryId))
      .where(eq(entryRelation.entryId, entryId)),
  ]);
  if (!row) return undefined;
  const supersedes = row.entry.supersedesId
    ? (await db.select({ id: entry.id, number: entry.number, title: entry.title }).from(entry).where(eq(entry.id, row.entry.supersedesId)))[0]
    : undefined;
  return {
    title: row.entry.title,
    question: row.proposal.question,
    // Without its own summary, a draft shows the question as its summary.
    summary: row.entry.summary === clipText(row.proposal.question, SUMMARY_MAX) ? undefined : row.entry.summary,
    body: row.entry.body,
    proposalText: version?.text ?? "",
    impact: row.entry.impact ?? undefined,
    reversibility: row.decision.reversibility ?? "two_way",
    reversibilityReason: row.decision.reversibilityReason ?? undefined,
    deciderId: row.decision.deciderId,
    consentGiverIds: people.filter((p) => p.role === "consent_giver").map((p) => p.personId),
    feedbackGiverIds: people.filter((p) => p.role === "feedback_giver").map((p) => p.personId),
    affectedTeamIds: teams.map((t) => t.id),
    teamId: row.entry.teamId,
    tagIds: tags.map((t) => t.id),
    feedbackDeadline: row.proposal.feedbackDeadline,
    objectionPeriodDays: row.proposal.objectionPeriodDays,
    supersedes: supersedes ? { id: supersedes.id, label: `${formatEntryRef(supersedes.number)}: ${supersedes.title}` } : undefined,
    reviewDate: row.decision.reviewDate ?? undefined,
    links: row.entry.links.map((link) => link.url),
    related: related.map((r) => ({ id: r.id, label: `${formatEntryRef(r.number)}: ${r.title}` })),
  };
}
