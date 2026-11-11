import { and, eq, isNull } from "drizzle-orm";
import { recordAudit, type AuditAction } from "@/lib/audit";
import { addWorkingDays } from "@/lib/calendar";
import type { Database, Transaction } from "@/lib/db/client";
import {
  decision,
  entry,
  entryAffectedTeam,
  entryRelation,
  entryTag,
  outcome,
  participant,
  proposal,
  proposalVersion,
  response,
} from "@/lib/db/schema";
import {
  assertActiveTags,
  assertActiveTeam,
  assertPeopleWithAccess,
  assertPublishedEntries,
  assertSupersedable,
  assertTeams,
  EntryError,
  markSuperseded,
  refreshSearchText,
  setAffectedTeams,
  setRelations,
  setTags,
} from "@/lib/entries/commands";
import { SUMMARY_MAX } from "@/lib/entries/constants";
import { clipText, serverDate } from "@/lib/format";
import { notifyProposal, proposalsInObjectionRound } from "@/lib/notifications/notify";
import type { ProposalEvent } from "@/lib/notifications/plan";
import { requestWebhook } from "@/lib/webhooks/sync";
import {
  MINIMUM_PERIODS,
  deciderChange,
  defaultFeedbackDeadline,
  consentGiverReplacement,
  deadlineExtension,
  mayGiveConsent,
  minimumFeedbackDeadline,
  nextReadySince,
  objectionHandlingRequired,
  objectionResolution,
  participantAddition,
  participantRemoval,
  permissions,
  questionAnswer,
  readiness,
  type Actor,
  type Check,
} from "./rules";
import type { ChangeReversibilityInput, ProposalDraftInput, PublishInput, ResponseInput, VersionInput } from "./schemas";
import { getDefaultPeriods } from "./settings";
import { loadProposal, type LoadedProposal } from "./snapshot";

/*
 * The process module: the only code that changes a proposal's status. Every
 * command locks the proposal, checks the rules, writes, and states its
 * effects (audit event, messages, search text, webhook), which withProposal
 * runs in one fixed order, all in one transaction. Drafts are private and
 * leave no audit trail until they are submitted.
 */

const forbidden = (message: string) => new EntryError("forbidden", message);
const invalid = (field: string, message: string) => new EntryError("invalid", message, { [field]: message });

interface AuditRecord {
  action: AuditAction;
  payload?: Record<string, unknown>;
}

/**
 * What a command changed, as its body states it. `withProposal` runs these
 * effects after the write.
 */
interface ProposalEffects<T> {
  audit: AuditRecord | AuditRecord[];
  /** The text the search reads changed. */
  searchText?: boolean;
  /** Readiness counts anew, so a new decider of a ready proposal is told. */
  restartReadiness?: boolean;
  /** What the people on the proposal hear about, planned from the state after the write. */
  event?: ProposalEvent;
  /** The entry's webhook payload changed. */
  webhook?: boolean;
  /** What the command returns. */
  result?: T;
}

/**
 * Runs a command on a locked proposal: `run` checks the rules, writes, and
 * states its effects. Then, in the same transaction and in this order: the
 * audit events, the search text, one reload of the proposal, readiness, the
 * messages, and the webhook.
 */
async function withProposal<T = void>(
  db: Database,
  actor: Actor,
  entryId: string,
  now: Date,
  run: (tx: Transaction, loaded: LoadedProposal) => Promise<ProposalEffects<T>>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const loaded = await loadProposal(tx, entryId, { lock: true });
    if (!loaded) throw new EntryError("not_found", "This proposal does not exist.");
    const effects = await run(tx, loaded);
    for (const record of [effects.audit].flat()) await recordAudit(tx, { actorId: actor.personId, entryId, ...record });
    if (effects.searchText) await refreshSearchText(tx, entryId);
    const after = await loadProposal(tx, entryId);
    if (!after) throw new Error(`Proposal ${entryId} disappeared during a write`);
    await settle(tx, after, actor.personId, effects, now);
    if (effects.webhook) await requestWebhook(tx, entryId, now);
    return effects.result as T;
  });
}

/**
 * Keeps `proposal.ready_since` in step with the publish criteria
 * (`nextReadySince`), then records the messages: the stated event, and
 * "ready to decide" when the proposal just became ready. Nobody hears about
 * their own action.
 */
async function settle(
  tx: Transaction,
  after: LoadedProposal,
  actorId: string | null,
  effects: Pick<ProposalEffects<unknown>, "event" | "restartReadiness">,
  now: Date,
) {
  const before = after.proposal.readySince;
  const next = nextReadySince(after.snapshot, before, now, effects.restartReadiness);
  if (next.readySince?.getTime() !== before?.getTime()) {
    await tx.update(proposal).set({ readySince: next.readySince }).where(eq(proposal.entryId, after.entry.id));
  }
  const events: ProposalEvent[] = [];
  if (effects.event) events.push(effects.event);
  if (next.becameReady) events.push({ type: "ready", since: now });
  await notifyProposal(tx, after, actorId, events, now);
}

/**
 * Runs every few minutes in the worker: proposals in the objection round may
 * become ready as their deadline passes, or stop being ready when someone
 * loses access. The decider is told once.
 */
export async function refreshReadiness(db: Database, now: Date): Promise<void> {
  for (const entryId of await proposalsInObjectionRound(db)) {
    await db.transaction(async (tx) => {
      const loaded = await loadProposal(tx, entryId, { lock: true });
      if (loaded) await settle(tx, loaded, null, {}, now);
    });
  }
}

function allow(allowed: boolean, message: string) {
  if (!allowed) throw forbidden(message);
}

/** Throws the reason of a failed check: on its input field if it names one, otherwise as forbidden. */
function enforce(check: Check) {
  if (check.ok) return;
  const message = check.reason ?? "This is not possible now.";
  throw check.field ? invalid(check.field, message) : forbidden(message);
}

const max = (a: string, b: string) => (a > b ? a : b);

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

async function validateDraftReferences(tx: Transaction, actor: Actor, input: ProposalDraftInput) {
  await assertActiveTeam(tx, input.teamId);
  await assertActiveTags(tx, input.tagIds);
  if (input.deciderId) await assertPeopleWithAccess(tx, "deciderId", [input.deciderId]);
  const consentGiverIds = input.reversibility === "one_way" ? input.consentGiverIds : [];
  await assertPeopleWithAccess(tx, "consentGiverIds", consentGiverIds);
  await assertPeopleWithAccess(tx, "feedbackGiverIds", input.feedbackGiverIds);
  const refused = consentGiverIds.map((id) => mayGiveConsent(actor.personId, id)).find((check) => !check.ok);
  if (refused) throw invalid("consentGiverIds", refused.reason!);
  await assertTeams(tx, "affectedTeamIds", input.affectedTeamIds);
  await assertPublishedEntries(tx, "relatedIds", input.relatedIds);
  if (input.supersedesId) await assertSupersedable(tx, input.supersedesId, { reversibility: input.reversibility, proposal: true });
}

async function writeDraftChildren(tx: Transaction, actor: Actor, entryId: string, input: ProposalDraftInput, now: Date) {
  const consentGiverIds = input.reversibility === "one_way" ? input.consentGiverIds : [];
  await tx.delete(participant).where(eq(participant.entryId, entryId));
  const participants = [
    ...consentGiverIds.map((personId) => ({ personId, role: "consent_giver" as const })),
    ...input.feedbackGiverIds.map((personId) => ({ personId, role: "feedback_giver" as const })),
  ];
  if (participants.length > 0) {
    await tx.insert(participant).values(participants.map((p) => ({ ...p, entryId, addedById: actor.personId, addedAt: now })));
  }
  await setAffectedTeams(tx, entryId, input.affectedTeamIds);
  await setTags(tx, entryId, input.tagIds);
  await setRelations(tx, entryId, input.relatedIds);
}

/** Creates a private draft, or saves changes to the actor's own draft. */
export async function saveDraft(db: Database, actor: Actor, input: ProposalDraftInput, draftId?: string, now = new Date()) {
  return db.transaction(async (tx) => {
    await validateDraftReferences(tx, actor, input);
    const periods = await getDefaultPeriods(tx);
    const feedbackDeadline = input.feedbackDeadline ?? defaultFeedbackDeadline(input.reversibility, periods, serverDate(now));
    const entryValues = {
      title: input.title,
      // Questions may be longer than a summary.
      summary: input.summary ?? clipText(input.question, SUMMARY_MAX),
      body: input.body ?? "",
      impact: input.impact ?? null,
      teamId: input.teamId,
      links: input.links.map((url) => ({ url })),
      supersedesId: input.supersedesId ?? null,
      updatedAt: now,
    };
    const decisionValues = {
      reversibility: input.reversibility,
      reversibilityReason: input.reversibility === "one_way" ? (input.reversibilityReason ?? null) : null,
      deciderId: input.deciderId ?? actor.personId,
      howDecided: "integrative_process" as const,
      reviewDate: input.reviewDate ?? null,
      updatedAt: now,
    };
    const proposalValues = {
      question: input.question,
      feedbackDeadline,
      objectionPeriodDays: input.objectionPeriodDays,
      updatedAt: now,
    };

    if (draftId) {
      const [current] = await tx.select().from(entry).where(eq(entry.id, draftId)).for("update");
      const [isProposal] = current ? await tx.select({ id: proposal.entryId }).from(proposal).where(eq(proposal.entryId, draftId)) : [];
      if (!current || !isProposal) throw new EntryError("not_found", "This draft does not exist.");
      if (current.authorId !== actor.personId) throw forbidden("Only the proposer can edit a draft.");
      if (current.status !== "draft") throw forbidden("A submitted proposal changes through new versions.");
      await tx.update(entry).set(entryValues).where(eq(entry.id, draftId));
      await tx.update(decision).set(decisionValues).where(eq(decision.entryId, draftId));
      await tx.update(proposal).set(proposalValues).where(eq(proposal.entryId, draftId));
      await tx
        .update(proposalVersion)
        .set({ text: input.proposalText ?? "" })
        .where(and(eq(proposalVersion.entryId, draftId), eq(proposalVersion.number, 1)));
      await writeDraftChildren(tx, actor, draftId, input, now);
      return { id: current.id, number: current.number };
    }

    const [created] = await tx
      .insert(entry)
      .values({ ...entryValues, type: "decision", status: "draft", authorId: actor.personId, createdAt: now })
      .returning({ id: entry.id, number: entry.number });
    if (!created) throw new Error("Could not create the draft");
    await tx.insert(decision).values({ ...decisionValues, entryId: created.id });
    await tx.insert(proposal).values({ ...proposalValues, entryId: created.id, currentVersion: 1 });
    await tx.insert(proposalVersion).values({
      entryId: created.id,
      number: 1,
      text: input.proposalText ?? "",
      createdById: actor.personId,
      createdAt: now,
    });
    await writeDraftChildren(tx, actor, created.id, input, now);
    return created;
  });
}

/** Deletes an unsubmitted draft (the only deletion Logbuch allows). */
export async function discardDraft(db: Database, actor: Actor, entryId: string) {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(entry).where(eq(entry.id, entryId)).for("update");
    const [isProposal] = current ? await tx.select({ id: proposal.entryId }).from(proposal).where(eq(proposal.entryId, entryId)) : [];
    if (!current || !isProposal || current.status !== "draft") throw new EntryError("not_found", "This draft does not exist.");
    if (current.authorId !== actor.personId) throw forbidden("Only the proposer can discard a draft.");
    await tx.delete(entryAffectedTeam).where(eq(entryAffectedTeam.entryId, entryId));
    await tx.delete(entryTag).where(eq(entryTag.entryId, entryId));
    await tx.delete(entryRelation).where(eq(entryRelation.entryId, entryId));
    await tx.delete(participant).where(eq(participant.entryId, entryId));
    await tx.delete(proposalVersion).where(eq(proposalVersion.entryId, entryId));
    await tx.delete(proposal).where(eq(proposal.entryId, entryId));
    await tx.delete(decision).where(eq(decision.entryId, entryId));
    await tx.delete(entry).where(eq(entry.id, entryId));
  });
}

/** Problems that keep a draft from being submitted, by field. */
export async function submissionErrors(tx: Database | Transaction, loaded: LoadedProposal, now: Date): Promise<Record<string, string>> {
  const { proposal: p, decision: d, entry: e, snapshot: s } = loaded;
  const errors: Record<string, string> = {};
  const [version] = await tx
    .select({ text: proposalVersion.text })
    .from(proposalVersion)
    .where(and(eq(proposalVersion.entryId, p.entryId), eq(proposalVersion.number, 1)));
  if (!e.body.trim()) errors.body = "Describe the context: why this matters now.";
  if (!version?.text.trim()) errors.proposalText = "Write the proposal.";
  if (!e.impact) errors.impact = "Choose the impact.";
  if (!s.deciderHasAccess) errors.deciderId = "Choose a decider who has access.";
  if (s.reversibility === "one_way") {
    if (!d.reversibilityReason?.trim()) errors.reversibilityReason = "Explain why the decision is hard to reverse.";
    const givers = s.participants.filter((x) => x.role === "consent_giver");
    if (givers.length === 0) errors.consentGiverIds = "A one-way proposal needs at least one consent giver.";
    else if (givers.some((x) => !x.hasAccess)) errors.consentGiverIds = "Every consent giver needs access.";
  }
  const minimum = minimumFeedbackDeadline(s.reversibility, serverDate(now));
  if (p.feedbackDeadline < minimum) errors.feedbackDeadline = `The feedback deadline must be ${minimum} or later.`;
  if (p.objectionPeriodDays < MINIMUM_PERIODS[s.reversibility].objection) {
    errors.objectionPeriodDays = `At least ${MINIMUM_PERIODS[s.reversibility].objection} working days.`;
  }
  return errors;
}

/** Submits a draft: the feedback phase starts and everyone with access can see it. */
export async function submitProposal(db: Database, actor: Actor, entryId: string, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).submit, "Only the proposer can submit a draft.");
    const errors = await submissionErrors(tx, loaded, now);
    if (loaded.entry.supersedesId) {
      await assertSupersedable(tx, loaded.entry.supersedesId, { reversibility: loaded.snapshot.reversibility, proposal: true }).catch((error: unknown) => {
        if (error instanceof EntryError) Object.assign(errors, error.fieldErrors);
        else throw error;
      });
    }
    if (Object.keys(errors).length > 0) throw new EntryError("invalid", "The proposal is not complete yet.", errors);

    await tx
      .update(entry)
      .set({ status: "feedback", submittedAt: now, publishedAt: now, personalDataConfirmedAt: now, updatedAt: now })
      .where(eq(entry.id, entryId));
    await tx.update(proposalVersion).set({ personalDataConfirmedAt: now }).where(eq(proposalVersion.id, loaded.currentVersionId));
    return {
      audit: {
        action: "proposal.submitted",
        payload: { reversibility: loaded.snapshot.reversibility, feedbackDeadline: loaded.proposal.feedbackDeadline },
      },
      searchText: true,
      event: { type: "submitted" },
    };
  });
}

// ---------------------------------------------------------------------------
// Versions and responses
// ---------------------------------------------------------------------------

/** A new version of the proposal text. For one-way, every earlier Go must be given again. */
export async function addVersion(db: Database, actor: Actor, entryId: string, input: VersionInput, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).newVersion, "Only the proposer adds versions while the proposal is open.");
    const number = loaded.proposal.currentVersion + 1;
    await tx.insert(proposalVersion).values({
      entryId,
      number,
      text: input.proposalText,
      changeNote: input.changeNote ?? null,
      createdById: actor.personId,
      personalDataConfirmedAt: now,
      createdAt: now,
    });
    await tx.update(proposal).set({ currentVersion: number, updatedAt: now }).where(eq(proposal.entryId, entryId));
    await tx.update(entry).set({ updatedAt: now }).where(eq(entry.id, entryId));
    return {
      audit: { action: "proposal.version_added", payload: { version: number } },
      searchText: true,
      event: { type: "version", version: number },
      result: number,
    };
  });
}

const RESPONSE_AUDIT = {
  question: "proposal.question_asked",
  feedback: "proposal.feedback_given",
  objection: "proposal.objection_raised",
} as const;

/** A question, feedback, or objection on the current version. */
export async function postResponse(db: Database, actor: Actor, entryId: string, input: ResponseInput, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const p = permissions(loaded.snapshot, actor, now);
    const allowed = { question: p.ask, feedback: p.giveFeedback, objection: p.object }[input.kind];
    const message = {
      question: "Questions are possible while the proposal is open.",
      feedback: "Feedback is possible in the feedback phase.",
      objection: "Objections are possible in the objection round.",
    }[input.kind];
    allow(allowed, message);
    const [created] = await tx
      .insert(response)
      .values({ entryId, personId: actor.personId, kind: input.kind, versionId: loaded.currentVersionId, text: input.text, createdAt: now })
      .returning({ id: response.id });
    await tx.update(entry).set({ updatedAt: now }).where(eq(entry.id, entryId));
    if (!created) throw new Error("Could not record the response");
    return {
      audit: { action: RESPONSE_AUDIT[input.kind], payload: { responseId: created.id } },
      // Feedback is read on the page; questions and objections are announced.
      event: input.kind === "feedback" ? undefined : { type: input.kind, responseId: created.id },
      result: created,
    };
  });
}

export async function answerQuestion(db: Database, actor: Actor, entryId: string, input: { questionId: string; text: string }, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    enforce(questionAnswer(loaded.snapshot, actor, now, input.questionId));
    await tx.insert(response).values({
      entryId,
      personId: actor.personId,
      kind: "answer",
      versionId: loaded.currentVersionId,
      text: input.text,
      parentId: input.questionId,
      createdAt: now,
    });
    return {
      audit: { action: "proposal.question_answered", payload: { questionId: input.questionId } },
      event: { type: "answered", questionId: input.questionId },
    };
  });
}

/**
 * A Go on the version the person read (one-way: consent givers; two-way:
 * requested people). If a newer version was added meanwhile, the Go is refused.
 */
export async function giveGo(db: Database, actor: Actor, entryId: string, input: { text?: string; version: number }, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).go, "You cannot give a Go on this proposal now.");
    if (input.version !== loaded.proposal.currentVersion) {
      throw invalid("version", `Version ${loaded.proposal.currentVersion} was added after you opened the page. Read it, then give your Go.`);
    }
    await tx.insert(response).values({
      entryId,
      personId: actor.personId,
      kind: "go",
      versionId: loaded.currentVersionId,
      text: input.text ?? "",
      createdAt: now,
    });
    // The decider hears through readiness once the last Go makes the proposal ready.
    return { audit: { action: "proposal.go_given", payload: { version: loaded.proposal.currentVersion } } };
  });
}

/** Withdraws the actor's Go; allowed until publication. */
export async function withdrawGo(db: Database, actor: Actor, entryId: string, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).withdrawGo, "There is no Go to withdraw.");
    await tx
      .update(response)
      .set({ withdrawnAt: now })
      .where(and(eq(response.entryId, entryId), eq(response.personId, actor.personId), eq(response.kind, "go"), isNull(response.withdrawnAt)));
    return { audit: { action: "proposal.go_withdrawn" } };
  });
}

/** The objector marks their objection resolved. */
export async function resolveObjection(
  db: Database,
  actor: Actor,
  entryId: string,
  input: { responseId: string; note?: string },
  now = new Date(),
) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    enforce(objectionResolution(loaded.snapshot, actor, input.responseId));
    await tx
      .update(response)
      .set({ resolvedAt: now, resolvedById: actor.personId, resolutionNote: input.note ?? null })
      .where(eq(response.id, input.responseId));
    return { audit: { action: "proposal.objection_resolved", payload: { responseId: input.responseId } } };
  });
}

// ---------------------------------------------------------------------------
// Phases and deadlines
// ---------------------------------------------------------------------------

/** The objection deadline is set now, from the period in working days. */
export async function startObjectionRound(db: Database, actor: Actor, entryId: string, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const check = permissions(loaded.snapshot, actor, now).startObjectionRound;
    if (!check.ok) throw new EntryError(actor.personId === loaded.snapshot.proposerId ? "invalid" : "forbidden", check.reason ?? "Not possible now.");
    const objectionDeadline = addWorkingDays(serverDate(now), loaded.proposal.objectionPeriodDays);
    await tx.update(entry).set({ status: "objection_round", updatedAt: now }).where(eq(entry.id, entryId));
    await tx
      .update(proposal)
      .set({ objectionRoundStartedAt: now, objectionDeadline, updatedAt: now })
      .where(eq(proposal.entryId, entryId));
    return {
      audit: { action: "proposal.objection_round_started", payload: { objectionDeadline } },
      event: { type: "objection_round" },
      result: objectionDeadline,
    };
  });
}

/** Deadlines can be extended, never shortened. */
export async function extendDeadline(
  db: Database,
  actor: Actor,
  entryId: string,
  input: { phase: "feedback" | "objection"; deadline: string },
  now = new Date(),
) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    enforce(deadlineExtension(loaded.snapshot, actor, now, input));
    const deadline = input.phase === "feedback" ? { feedbackDeadline: input.deadline } : { objectionDeadline: input.deadline };
    await tx.update(proposal).set({ ...deadline, updatedAt: now }).where(eq(proposal.entryId, entryId));
    const from = input.phase === "feedback" ? loaded.proposal.feedbackDeadline : loaded.proposal.objectionDeadline;
    return {
      audit: { action: "proposal.deadline_extended", payload: { phase: input.phase, from, to: input.deadline } },
      event: { type: "deadline_extended", phase: input.phase, deadline: input.deadline },
    };
  });
}

/**
 * Two-way to one-way is allowed until publication and needs consent givers;
 * during the objection round the proposal returns to Feedback with at least 5
 * working days. One-way to two-way only in the feedback phase, with a reason;
 * consent givers become feedback givers.
 */
export async function changeReversibility(db: Database, actor: Actor, entryId: string, input: ChangeReversibilityInput, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const { snapshot: s, proposal: p } = loaded;
    allow(permissions(s, actor, now).changeReversibility, "Two-way or one-way cannot be changed now.");
    if (input.to === s.reversibility) throw invalid("to", `The proposal is already ${input.to === "one_way" ? "one-way" : "two-way"}.`);
    // A one-way decision can only be replaced through a one-way proposal.
    if (loaded.entry.supersedesId) await assertSupersedable(tx, loaded.entry.supersedesId, { reversibility: input.to, proposal: true });
    const today = serverDate(now);

    if (input.to === "one_way") {
      if (!input.reversibilityReason) throw invalid("reversibilityReason", "Explain why the decision is hard to reverse.");
      const existing = s.participants.filter((x) => x.role === "consent_giver").map((x) => x.personId);
      const added = input.consentGiverIds.filter((id) => !existing.includes(id));
      if (existing.length + added.length === 0) throw invalid("consentGiverIds", "A one-way proposal needs at least one consent giver.");
      const refused = added.map((id) => mayGiveConsent(s.proposerId, id)).find((check) => !check.ok);
      if (refused) throw invalid("consentGiverIds", refused.reason!);
      await assertPeopleWithAccess(tx, "consentGiverIds", added);
      if (added.length > 0) {
        await tx
          .insert(participant)
          .values(added.map((personId) => ({ entryId, personId, role: "consent_giver" as const, addedById: actor.personId, addedAt: now })));
      }
      const minimumFrom = s.status === "objection_round" ? today : (s.submittedOn ?? today);
      const feedbackDeadline = max(p.feedbackDeadline, addWorkingDays(minimumFrom, MINIMUM_PERIODS.one_way.feedback));
      await tx
        .update(decision)
        .set({ reversibility: "one_way", reversibilityReason: input.reversibilityReason, updatedAt: now })
        .where(eq(decision.entryId, entryId));
      await tx
        .update(proposal)
        .set({
          feedbackDeadline,
          objectionPeriodDays: Math.max(p.objectionPeriodDays, MINIMUM_PERIODS.one_way.objection),
          objectionRoundStartedAt: null,
          objectionDeadline: null,
          // Gos given under two-way rules are not binding consent.
          goResetAt: now,
          updatedAt: now,
        })
        .where(eq(proposal.entryId, entryId));
      if (s.status === "objection_round") {
        await tx.update(entry).set({ status: "feedback", updatedAt: now }).where(eq(entry.id, entryId));
      }
    } else {
      const givers = s.participants.filter((x) => x.role === "consent_giver").map((x) => x.personId);
      if (givers.length > 0) {
        await tx
          .update(participant)
          .set({ removedAt: now, removedById: actor.personId, removalReason: "Changed to two-way" })
          .where(and(eq(participant.entryId, entryId), eq(participant.role, "consent_giver"), isNull(participant.removedAt)));
        const feedbackGivers = s.participants.filter((x) => x.role === "feedback_giver").map((x) => x.personId);
        const toAdd = givers.filter((id) => !feedbackGivers.includes(id));
        if (toAdd.length > 0) {
          await tx
            .insert(participant)
            .values(toAdd.map((personId) => ({ entryId, personId, role: "feedback_giver" as const, addedById: actor.personId, addedAt: now })));
        }
      }
      await tx.update(decision).set({ reversibility: "two_way", reversibilityReason: null, updatedAt: now }).where(eq(decision.entryId, entryId));
      await tx.update(proposal).set({ updatedAt: now }).where(eq(proposal.entryId, entryId));
    }
    const backToFeedback = s.status === "objection_round";
    return {
      audit: { action: "proposal.type_changed", payload: { from: s.reversibility, to: input.to, reason: input.reason, backToFeedback } },
      event: input.to === "one_way" ? { type: "one_way", at: now, backToFeedback } : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export async function addParticipant(
  db: Database,
  actor: Actor,
  entryId: string,
  input: { personId: string; role: "consent_giver" | "feedback_giver" },
  now = new Date(),
) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const { snapshot: s } = loaded;
    enforce(participantAddition(s, actor, now, input));
    await assertPeopleWithAccess(tx, "personId", [input.personId]);
    await tx.insert(participant).values({ entryId, personId: input.personId, role: input.role, addedById: actor.personId, addedAt: now });
    return {
      audit: { action: "proposal.participant_added", payload: { personId: input.personId, role: input.role } },
      event: { type: "participant_added", personId: input.personId, role: input.role, at: now },
    };
  });
}

/** Removes a listed person, following `participantRemoval` in the rules. */
export async function removeParticipant(
  db: Database,
  actor: Actor,
  entryId: string,
  input: { personId: string; role: "consent_giver" | "feedback_giver"; reason?: string },
  now = new Date(),
) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const check = participantRemoval(loaded.snapshot, actor, now, input);
    enforce(check);
    if (check.reasonRequired && !input.reason) throw invalid("reason", "Give a reason.");
    await tx
      .update(participant)
      .set({ removedAt: now, removedById: actor.personId, removalReason: input.reason ?? null })
      .where(
        and(eq(participant.entryId, entryId), eq(participant.personId, input.personId), eq(participant.role, input.role), isNull(participant.removedAt)),
      );
    return { audit: { action: "proposal.participant_removed", payload: { personId: input.personId, role: input.role, reason: input.reason ?? null } } };
  });
}

/** An admin replaces a consent giver in a stuck process, with a recorded reason. */
export async function replaceConsentGiver(
  db: Database,
  actor: Actor,
  entryId: string,
  input: { personId: string; replacementId: string; reason: string },
  now = new Date(),
) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const { snapshot: s } = loaded;
    enforce(consentGiverReplacement(s, actor, now, input));
    await assertPeopleWithAccess(tx, "replacementId", [input.replacementId]);
    await tx
      .update(participant)
      .set({ removedAt: now, removedById: actor.personId, removalReason: input.reason })
      .where(and(eq(participant.entryId, entryId), eq(participant.personId, input.personId), eq(participant.role, "consent_giver"), isNull(participant.removedAt)));
    await tx
      .insert(participant)
      .values({ entryId, personId: input.replacementId, role: "consent_giver", addedById: actor.personId, addedAt: now });
    return {
      audit: [
        {
          action: "proposal.participant_removed",
          payload: { personId: input.personId, role: "consent_giver", reason: input.reason, replacedBy: input.replacementId },
        },
        { action: "proposal.participant_added", payload: { personId: input.replacementId, role: "consent_giver" } },
      ],
      event: { type: "participant_added", personId: input.replacementId, role: "consent_giver", at: now },
    };
  });
}

/** The proposer changes the decider in the feedback phase; afterwards only an admin, with a reason. */
export async function changeDecider(db: Database, actor: Actor, entryId: string, input: { deciderId: string; reason?: string }, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const { snapshot: s } = loaded;
    const check = deciderChange(s, actor, input.deciderId);
    enforce(check);
    if (check.reasonRequired && !input.reason) throw invalid("reason", "Give a reason.");
    await assertPeopleWithAccess(tx, "deciderId", [input.deciderId]);
    await tx.update(decision).set({ deciderId: input.deciderId, updatedAt: now }).where(eq(decision.entryId, entryId));
    await tx.update(proposal).set({ updatedAt: now }).where(eq(proposal.entryId, entryId));
    return {
      audit: { action: "proposal.decider_changed", payload: { from: s.deciderId, to: input.deciderId, reason: input.reason ?? null } },
      restartReadiness: true,
      event: { type: "decider_changed", at: now },
    };
  });
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** The decider publishes the decision once the criteria are met. */
export async function publishDecision(db: Database, actor: Actor, entryId: string, input: PublishInput, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    const { snapshot: s } = loaded;
    allow(actor.personId === s.deciderId, "Only the decider publishes the decision.");
    const ready = readiness(s, now);
    if (!ready.ready) throw new EntryError("invalid", "The publish criteria are not met yet.");
    if (objectionHandlingRequired(s) && !input.objectionHandling) {
      throw invalid("objectionHandling", "Explain how the objections were addressed.");
    }
    if (loaded.entry.supersedesId) await assertSupersedable(tx, loaded.entry.supersedesId, { reversibility: s.reversibility, proposal: true });

    await tx
      .update(entry)
      .set({ status: "decided", summary: input.summary, rationale: input.rationale, personalDataConfirmedAt: now, updatedAt: now })
      .where(eq(entry.id, entryId));
    await tx.update(decision).set({ effectiveDate: input.effectiveDate ?? null, updatedAt: now }).where(eq(decision.entryId, entryId));
    await tx.insert(outcome).values({
      entryId,
      result: "adopted",
      finalText: input.finalText,
      objectionHandling: input.objectionHandling ?? null,
      decidedById: actor.personId,
      decidedOn: serverDate(now),
      personalDataConfirmedAt: now,
      createdAt: now,
    });
    if (loaded.entry.supersedesId) await markSuperseded(tx, actor.personId, loaded.entry.supersedesId, entryId, now);
    return {
      audit: { action: "proposal.decided", payload: { version: s.currentVersion } },
      searchText: true,
      event: { type: "closed", result: "decided" },
      webhook: true,
    };
  });
}

async function close(
  tx: Transaction,
  actor: Actor,
  loaded: LoadedProposal,
  result: "rejected" | "withdrawn",
  rationale: string,
  now: Date,
): Promise<ProposalEffects<void>> {
  const entryId = loaded.entry.id;
  await tx.update(entry).set({ status: result, rationale, personalDataConfirmedAt: now, updatedAt: now }).where(eq(entry.id, entryId));
  await tx.insert(outcome).values({
    entryId,
    result,
    finalText: "",
    decidedById: actor.personId,
    decidedOn: serverDate(now),
    personalDataConfirmedAt: now,
    createdAt: now,
  });
  return {
    audit: { action: result === "rejected" ? "proposal.rejected" : "proposal.withdrawn" },
    searchText: true,
    event: { type: "closed", result },
    // Withdrawn proposals are not sent to the webhook.
    webhook: result === "rejected",
  };
}

/** The only way to reject a proposal: the decider, with a rationale. */
export async function rejectProposal(db: Database, actor: Actor, entryId: string, input: { rationale: string }, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).reject, "Only the decider rejects an open proposal.");
    return close(tx, actor, loaded, "rejected", input.rationale, now);
  });
}

export async function withdrawProposal(db: Database, actor: Actor, entryId: string, input: { reason?: string }, now = new Date()) {
  return withProposal(db, actor, entryId, now, async (tx, loaded) => {
    allow(permissions(loaded.snapshot, actor, now).withdraw, "Only the proposer withdraws an open proposal.");
    return close(tx, actor, loaded, "withdrawn", input.reason ?? "", now);
  });
}
