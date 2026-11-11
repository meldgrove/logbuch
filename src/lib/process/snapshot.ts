import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database, Transaction } from "@/lib/db/client";
import { decision, entry, participant, person, proposal, proposalVersion, response } from "@/lib/db/schema";
import { serverDate } from "@/lib/format";
import type { ProposalSnapshot, ProposalStatus, RequestedRole } from "./rules";

export interface LoadedProposal {
  entry: typeof entry.$inferSelect;
  proposal: typeof proposal.$inferSelect;
  decision: typeof decision.$inferSelect;
  snapshot: ProposalSnapshot;
  currentVersionId: string;
}

/**
 * Loads everything the rules need for one proposal. Pass `lock` inside a
 * transaction to serialize writes on the same proposal.
 */
export async function loadProposal(
  db: Database | Transaction,
  entryId: string,
  options: { lock?: boolean } = {},
): Promise<LoadedProposal | undefined> {
  const entryQuery = db.select().from(entry).where(eq(entry.id, entryId));
  const [entryRow] = options.lock ? await entryQuery.for("update") : await entryQuery;
  if (!entryRow || entryRow.type !== "decision") return undefined;

  const [[proposalRow], [decisionRow], participants, responses, versions, [decider]] = await Promise.all([
    db.select().from(proposal).where(eq(proposal.entryId, entryId)),
    db.select().from(decision).where(eq(decision.entryId, entryId)),
    db
      .select({ personId: participant.personId, role: participant.role, hasAccess: person.hasAccess })
      .from(participant)
      .innerJoin(person, eq(person.id, participant.personId))
      .where(and(eq(participant.entryId, entryId), isNull(participant.removedAt))),
    db
      .select({
        id: response.id,
        personId: response.personId,
        kind: response.kind,
        versionNumber: proposalVersion.number,
        createdAt: response.createdAt,
        resolvedAt: response.resolvedAt,
        withdrawnAt: response.withdrawnAt,
        parentId: response.parentId,
      })
      .from(response)
      .innerJoin(proposalVersion, eq(proposalVersion.id, response.versionId))
      .where(eq(response.entryId, entryId))
      .orderBy(asc(response.createdAt), asc(response.id)),
    db.select({ id: proposalVersion.id, number: proposalVersion.number }).from(proposalVersion).where(eq(proposalVersion.entryId, entryId)),
    db
      .select({ hasAccess: person.hasAccess })
      .from(decision)
      .innerJoin(person, eq(person.id, decision.deciderId))
      .where(eq(decision.entryId, entryId)),
  ]);
  // A logged decision has no proposal row.
  if (!proposalRow) return undefined;
  if (!decisionRow) throw new Error(`Proposal ${entryId} has no decision row`);
  const current = versions.find((v) => v.number === proposalRow.currentVersion);
  if (!current) throw new Error(`Proposal ${entryId} has no version ${proposalRow.currentVersion}`);

  return {
    entry: entryRow,
    proposal: proposalRow,
    decision: decisionRow,
    currentVersionId: current.id,
    snapshot: {
      status: entryRow.status as ProposalStatus,
      // Proposals always have a reversibility; only imported decisions may lack one.
      reversibility: decisionRow.reversibility ?? "two_way",
      proposerId: entryRow.authorId,
      deciderId: decisionRow.deciderId,
      deciderHasAccess: decider?.hasAccess ?? false,
      submittedOn: entryRow.submittedAt ? serverDate(entryRow.submittedAt) : null,
      feedbackDeadline: proposalRow.feedbackDeadline,
      objectionPeriodDays: proposalRow.objectionPeriodDays,
      objectionRoundStartedAt: proposalRow.objectionRoundStartedAt,
      objectionDeadline: proposalRow.objectionDeadline,
      currentVersion: proposalRow.currentVersion,
      goResetAt: proposalRow.goResetAt,
      participants: participants
        .filter((p): p is typeof p & { role: RequestedRole } => p.role === "consent_giver" || p.role === "feedback_giver")
        .map((p) => ({ personId: p.personId, role: p.role, hasAccess: p.hasAccess })),
      responses,
    },
  };
}
