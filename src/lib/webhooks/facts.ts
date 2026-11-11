import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database, Transaction } from "@/lib/db/client";
import { addendum, decision, entry, entryAffectedTeam, entryTag, outcome, participant, person, proposal, response, tag, team } from "@/lib/db/schema";
import { openObjections } from "@/lib/process/rules";
import { loadProposal } from "@/lib/process/snapshot";
import type { EntryFacts } from "./payload";

type Db = Database | Transaction;

const supersedes = alias(entry, "supersedes");
const supersededBy = alias(entry, "superseded_by");

/** Everything the webhook payload of an entry needs. Undefined for a missing entry or a draft. */
export async function loadEntryFacts(db: Db, entryId: string): Promise<EntryFacts | undefined> {
  const [row] = await db
    .select({
      entry,
      teamName: team.name,
      authorName: person.displayName,
      supersedesNumber: supersedes.number,
      supersededByNumber: supersededBy.number,
    })
    .from(entry)
    .innerJoin(team, eq(team.id, entry.teamId))
    .innerJoin(person, eq(person.id, entry.authorId))
    .leftJoin(supersedes, eq(supersedes.id, entry.supersedesId))
    .leftJoin(supersededBy, eq(supersededBy.id, entry.supersededById))
    .where(eq(entry.id, entryId));
  if (!row || row.entry.status === "draft") return undefined;

  const nameOf = async (ids: string[]) => {
    if (ids.length === 0) return new Map<string, string>();
    const people = await db.select({ id: person.id, name: person.displayName }).from(person).where(inArray(person.id, ids));
    return new Map(people.map((p) => [p.id, p.name]));
  };

  const [[outcomeRow], [proposalRow], [decisionRow], affectedTeams, tags, listed, addenda] = await Promise.all([
    db.select().from(outcome).where(eq(outcome.entryId, entryId)),
    db.select().from(proposal).where(eq(proposal.entryId, entryId)),
    db.select().from(decision).where(eq(decision.entryId, entryId)),
    db
      .select({ name: team.name })
      .from(entryAffectedTeam)
      .innerJoin(team, eq(team.id, entryAffectedTeam.teamId))
      .where(eq(entryAffectedTeam.entryId, entryId))
      .orderBy(asc(team.name)),
    db
      .select({ name: tag.name })
      .from(entryTag)
      .innerJoin(tag, eq(tag.id, entryTag.tagId))
      .where(eq(entryTag.entryId, entryId))
      .orderBy(asc(tag.name)),
    db
      .select({ personId: participant.personId, role: participant.role })
      .from(participant)
      .where(and(eq(participant.entryId, entryId), isNull(participant.removedAt)))
      .orderBy(asc(participant.addedAt)),
    db
      .select({ text: addendum.text, authorId: addendum.authorId, createdAt: addendum.createdAt })
      .from(addendum)
      .where(eq(addendum.entryId, entryId))
      .orderBy(asc(addendum.createdAt)),
  ]);
  const names = await nameOf([
    ...listed.map((p) => p.personId),
    ...addenda.map((a) => a.authorId),
    ...(outcomeRow ? [outcomeRow.decidedById] : []),
    ...(decisionRow ? [decisionRow.deciderId] : []),
  ]);
  const name = (id: string) => names.get(id) ?? "Unknown";

  let objections: string[] = [];
  if (proposalRow && decisionRow?.reversibility === "two_way" && row.entry.status === "decided") {
    const loaded = await loadProposal(db, entryId);
    const ids = loaded ? openObjections(loaded.snapshot).map((r) => r.id) : [];
    if (ids.length > 0) {
      const texts = await db.select({ text: response.text }).from(response).where(inArray(response.id, ids)).orderBy(asc(response.createdAt));
      objections = texts.map((t) => t.text);
    }
  }

  return {
    entry: {
      id: row.entry.id,
      number: row.entry.number,
      type: row.entry.type,
      status: row.entry.status,
      title: row.entry.title,
      summary: row.entry.summary,
      body: row.entry.body,
      rationale: row.entry.rationale,
      impact: row.entry.impact,
      publishedAt: row.entry.publishedAt,
      supersedesNumber: row.supersedesNumber,
      supersededByNumber: row.supersededByNumber,
    },
    teamName: row.teamName,
    authorName: row.authorName,
    affectedTeamNames: affectedTeams.map((t) => t.name),
    tagNames: tags.map((t) => t.name),
    decision: decisionRow
      ? { reversibility: decisionRow.reversibility, howDecided: decisionRow.howDecided, deciderName: name(decisionRow.deciderId) }
      : null,
    proposal: proposalRow
      ? {
          currentVersion: proposalRow.currentVersion,
          consentGiverNames: listed.filter((p) => p.role === "consent_giver").map((p) => name(p.personId)),
        }
      : null,
    outcome: outcomeRow
      ? {
          result: outcomeRow.result,
          finalText: outcomeRow.finalText,
          objectionHandling: outcomeRow.objectionHandling,
          decidedOn: outcomeRow.decidedOn,
          decidedAt: outcomeRow.createdAt,
          decidedByName: name(outcomeRow.decidedById),
        }
      : null,
    involvedNames: listed.filter((p) => p.role === "involved").map((p) => name(p.personId)),
    addenda: addenda.map((a) => ({ text: a.text, authorName: name(a.authorId), createdAt: a.createdAt })),
    openObjections: objections,
  };
}
