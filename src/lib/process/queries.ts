import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { decision, entry, entryAffectedTeam, participant, person, proposal, proposalVersion, response, team } from "@/lib/db/schema";
import { submissionErrors } from "./commands";
import {
  awaitsAnswer,
  blockingObjections,
  canStartObjectionRound,
  consentGiverReplacement,
  deciderChange,
  isConsentGiver,
  isConsentingGo,
  objectionHandlingRequired,
  objectionResolution,
  openObjections,
  openQuestions,
  participantAddition,
  participantRemoval,
  participantState,
  permissions,
  readiness,
  type Actor,
} from "./rules";
import { loadProposal } from "./snapshot";

/**
 * Everything the proposal page shows, for one viewer. `candidates` are the
 * people the page can offer in its pickers; the view says which of them the
 * rules allow for each choice.
 */
export async function getProposalView(db: Database, entryId: string, viewer: Actor, candidates: string[] = [], now = new Date()) {
  const loaded = await loadProposal(db, entryId);
  if (!loaded) return undefined;
  const s = loaded.snapshot;

  const [versions, people, rows, affectedTeams, errors] = await Promise.all([
    db
      .select({
        id: proposalVersion.id,
        number: proposalVersion.number,
        text: proposalVersion.text,
        changeNote: proposalVersion.changeNote,
        createdAt: proposalVersion.createdAt,
        authorName: person.displayName,
      })
      .from(proposalVersion)
      .innerJoin(person, eq(person.id, proposalVersion.createdById))
      .where(eq(proposalVersion.entryId, entryId))
      .orderBy(asc(proposalVersion.number)),
    db
      .select({ id: person.id, name: person.displayName, hasAccess: person.hasAccess })
      .from(person)
      .where(
        or(
          inArray(person.id, [s.proposerId, s.deciderId]),
          inArray(person.id, db.select({ id: participant.personId }).from(participant).where(eq(participant.entryId, entryId))),
          inArray(person.id, db.select({ id: response.personId }).from(response).where(eq(response.entryId, entryId))),
        ),
      ),
    db
      .select({
        id: response.id,
        personId: response.personId,
        kind: response.kind,
        text: response.text,
        parentId: response.parentId,
        createdAt: response.createdAt,
        resolvedAt: response.resolvedAt,
        resolutionNote: response.resolutionNote,
        withdrawnAt: response.withdrawnAt,
        versionNumber: proposalVersion.number,
      })
      .from(response)
      .innerJoin(proposalVersion, eq(proposalVersion.id, response.versionId))
      .where(eq(response.entryId, entryId))
      .orderBy(asc(response.createdAt)),
    db
      .select({ id: team.id, name: team.name })
      .from(entryAffectedTeam)
      .innerJoin(team, eq(team.id, entryAffectedTeam.teamId))
      .where(eq(entryAffectedTeam.entryId, entryId))
      .orderBy(asc(team.name)),
    s.status === "draft" ? submissionErrors(db, loaded, now) : Promise.resolve({}),
  ]);
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const name = (id: string) => nameOf.get(id) ?? "Unknown";
  const open = new Set(openObjections(s).map((r) => r.id));
  const blocking = new Set(blockingObjections(s).map((r) => r.id));
  const withNames = rows.map((r) => ({ ...r, personName: name(r.personId) }));

  return {
    entryId,
    status: s.status,
    reversibility: s.reversibility,
    reversibilityReason: loaded.decision.reversibilityReason,
    question: loaded.proposal.question,
    feedbackDeadline: loaded.proposal.feedbackDeadline,
    objectionPeriodDays: loaded.proposal.objectionPeriodDays,
    objectionDeadline: loaded.proposal.objectionDeadline,
    reviewDate: loaded.decision.reviewDate,
    effectiveDate: loaded.decision.effectiveDate,
    currentVersion: s.currentVersion,
    proposer: { id: s.proposerId, name: name(s.proposerId) },
    decider: { id: s.deciderId, name: name(s.deciderId), hasAccess: s.deciderHasAccess },
    affectedTeams,
    versions,
    participants: s.participants.map((p) => ({
      personId: p.personId,
      name: name(p.personId),
      role: p.role,
      hasAccess: p.hasAccess,
      state: participantState(s, p.personId, p.hasAccess),
      removal: participantRemoval(s, viewer, now, p),
      /** Who may replace this consent giver. */
      replacements:
        p.role === "consent_giver"
          ? candidates.filter((id) => consentGiverReplacement(s, viewer, now, { personId: p.personId, replacementId: id }).ok)
          : [],
    })),
    questions: withNames
      .filter((r) => r.kind === "question")
      .map((q) => ({ ...q, answer: withNames.find((a) => a.kind === "answer" && a.parentId === q.id) })),
    feedback: withNames.filter((r) => r.kind === "feedback"),
    objections: withNames
      .filter((r) => r.kind === "objection")
      .map((o) => ({ ...o, open: open.has(o.id), blocking: blocking.has(o.id), mayResolve: objectionResolution(s, viewer, o.id).ok })),
    gos: withNames
      .filter((r) => r.kind === "go")
      .map((g) => ({ ...g, current: isConsentingGo(s, g) })),
    permissions: permissions(s, viewer, now),
    deciderChange: deciderChange(s, viewer),
    /** Who the viewer may add in each role, and who may become the decider. */
    choices: {
      feedbackGivers: candidates.filter((id) => participantAddition(s, viewer, now, { personId: id, role: "feedback_giver" }).ok),
      consentGivers: candidates.filter((id) => participantAddition(s, viewer, now, { personId: id, role: "consent_giver" }).ok),
      deciders: candidates.filter((id) => deciderChange(s, viewer, id).ok),
    },
    readiness: readiness(s, now),
    objectionHandlingRequired: objectionHandlingRequired(s),
    submissionErrors: errors as Record<string, string>,
    viewerIsConsentGiver: isConsentGiver(s, viewer.personId),
  };
}

export type ProposalView = NonNullable<Awaited<ReturnType<typeof getProposalView>>>;

// ---------------------------------------------------------------------------
// My tasks
// ---------------------------------------------------------------------------

export interface Task {
  key: string;
  label: string;
  number: number;
  title: string;
  due?: string;
  href: string;
}

/** What is waiting for this person. */
export async function getMyTasks(db: Database, personId: string, now = new Date()): Promise<Task[]> {
  const candidates = await db
    .selectDistinct({ id: entry.id, number: entry.number, title: entry.title, status: entry.status, authorId: entry.authorId })
    .from(entry)
    .innerJoin(proposal, eq(proposal.entryId, entry.id))
    .innerJoin(decision, eq(decision.entryId, entry.id))
    .leftJoin(participant, and(eq(participant.entryId, entry.id), isNull(participant.removedAt)))
    .where(
      and(
        or(
          and(eq(entry.status, "draft"), eq(entry.authorId, personId)),
          and(
            inArray(entry.status, ["feedback", "objection_round"]),
            or(eq(entry.authorId, personId), eq(decision.deciderId, personId), eq(participant.personId, personId)),
          ),
        ),
      ),
    )
    .orderBy(asc(entry.number));

  const tasks: Task[] = [];
  for (const candidate of candidates) {
    const base = { number: candidate.number, title: candidate.title, href: `/e/LB-${candidate.number}` };
    if (candidate.status === "draft") {
      tasks.push({ ...base, key: `${candidate.id}:draft`, label: "Finish and submit your draft" });
      continue;
    }
    const loaded = await loadProposal(db, candidate.id);
    if (!loaded) continue;
    const s = loaded.snapshot;

    if (awaitsAnswer(s, personId)) {
      if (s.status === "feedback") {
        tasks.push({ ...base, key: `${candidate.id}:feedback`, label: "Feedback requested", due: s.feedbackDeadline });
      } else if (s.reversibility === "one_way") {
        tasks.push({ ...base, key: `${candidate.id}:go`, label: `Go needed on version ${s.currentVersion}`, due: s.objectionDeadline ?? undefined });
      } else {
        tasks.push({ ...base, key: `${candidate.id}:answer`, label: "Go or objection requested", due: s.objectionDeadline ?? undefined });
      }
    }
    if (s.deciderId === personId && readiness(s, now).ready) {
      tasks.push({ ...base, key: `${candidate.id}:decide`, label: "Ready to decide", href: `${base.href}/decide` });
    }
    if (s.proposerId === personId) {
      const questions = openQuestions(s).length;
      if (questions > 0) tasks.push({ ...base, key: `${candidate.id}:questions`, label: `${questions} open question${questions === 1 ? "" : "s"}` });
      const objections = openObjections(s).length;
      if (objections > 0) tasks.push({ ...base, key: `${candidate.id}:objections`, label: `${objections} open objection${objections === 1 ? "" : "s"}` });
      if (s.status === "feedback" && canStartObjectionRound(s, now).ok) {
        tasks.push({ ...base, key: `${candidate.id}:start`, label: "Start the objection round", due: s.feedbackDeadline });
      }
    }
  }
  return tasks;
}

/** All versions of a proposal's text, oldest first. */
export async function getProposalVersions(db: Database, entryId: string) {
  return db
    .select({
      id: proposalVersion.id,
      number: proposalVersion.number,
      text: proposalVersion.text,
      changeNote: proposalVersion.changeNote,
      createdAt: proposalVersion.createdAt,
      authorName: person.displayName,
    })
    .from(proposalVersion)
    .innerJoin(person, eq(person.id, proposalVersion.createdById))
    .where(eq(proposalVersion.entryId, entryId))
    .orderBy(asc(proposalVersion.number));
}
