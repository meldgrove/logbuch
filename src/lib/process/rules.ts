import { addWorkingDays, isDeadlinePassed } from "@/lib/calendar";
import type { Reversibility } from "@/lib/entries/constants";

/*
 * The rules of the decision process as pure functions over
 * a snapshot of one proposal. Commands load a snapshot, check these rules,
 * and only then write. The UI uses the same rules to decide what to show.
 */

export type { Reversibility };
export type ProposalStatus = "draft" | "feedback" | "objection_round" | "decided" | "rejected" | "withdrawn";
export type ResponseKind = "question" | "answer" | "feedback" | "go" | "objection";
export type RequestedRole = "consent_giver" | "feedback_giver";

export interface Periods {
  feedback: number;
  objection: number;
}

/** Minimum periods in working days. Enforced. */
export const MINIMUM_PERIODS: Record<Reversibility, Periods> = {
  two_way: { feedback: 1, objection: 1 },
  one_way: { feedback: 5, objection: 3 },
};

/** Default periods in working days; admins can change them. */
export const DEFAULT_PERIODS: Record<Reversibility, Periods> = {
  two_way: { feedback: 2, objection: 1 },
  one_way: { feedback: 5, objection: 3 },
};

export interface SnapshotParticipant {
  personId: string;
  role: RequestedRole;
  hasAccess: boolean;
}

export interface SnapshotResponse {
  id: string;
  personId: string;
  kind: ResponseKind;
  versionNumber: number;
  createdAt: Date;
  resolvedAt: Date | null;
  withdrawnAt: Date | null;
  parentId: string | null;
}

export interface ProposalSnapshot {
  status: ProposalStatus;
  reversibility: Reversibility;
  proposerId: string;
  deciderId: string;
  deciderHasAccess: boolean;
  /** Date of submission, in the server's time zone. */
  submittedOn: string | null;
  feedbackDeadline: string;
  objectionPeriodDays: number;
  objectionRoundStartedAt: Date | null;
  objectionDeadline: string | null;
  currentVersion: number;
  /** Gos before this time do not count as one-way consent (set when a proposal becomes one-way). */
  goResetAt: Date | null;
  /** Active (not removed) consent and feedback givers. */
  participants: SnapshotParticipant[];
  responses: SnapshotResponse[];
}

export interface Actor {
  personId: string;
  isAdmin: boolean;
}

export interface Check {
  ok: boolean;
  reason?: string;
  /** The input field the reason is about. Without one, the actor may not do this now at all. */
  field?: string;
}

const ok: Check = { ok: true };
const no = (reason: string): Check => ({ ok: false, reason });
const invalidInput = (field: string, reason: string): Check => ({ ok: false, reason, field });

export function isOpen(status: ProposalStatus): boolean {
  return status === "feedback" || status === "objection_round";
}

/** Feedback givers and consent givers ("requested people"). */
export function requestedPeople(s: ProposalSnapshot): string[] {
  return [...new Set(s.participants.map((p) => p.personId))];
}

export function consentGivers(s: ProposalSnapshot): SnapshotParticipant[] {
  return s.reversibility === "one_way" ? s.participants.filter((p) => p.role === "consent_giver") : [];
}

export function isConsentGiver(s: ProposalSnapshot, personId: string): boolean {
  return consentGivers(s).some((p) => p.personId === personId);
}

const active = (r: SnapshotResponse) => r.withdrawnAt === null;

export function hasGivenFeedback(s: ProposalSnapshot, personId: string): boolean {
  return s.responses.some((r) => r.personId === personId && r.kind === "feedback");
}

/** A Go or an objection, not withdrawn. */
export function hasAnswered(s: ProposalSnapshot, personId: string): boolean {
  return s.responses.some((r) => r.personId === personId && (r.kind === "go" || r.kind === "objection") && active(r));
}

/** A Go that counts as consent now: on the current version, not withdrawn, given after any reset. */
export function isConsentingGo(s: ProposalSnapshot, r: SnapshotResponse): boolean {
  return (
    r.kind === "go" &&
    active(r) &&
    r.versionNumber === s.currentVersion &&
    (s.goResetAt === null || r.createdAt > s.goResetAt)
  );
}

/** A Go on the current version (one-way consent is tied to a version). */
export function hasGoOnCurrentVersion(s: ProposalSnapshot, personId: string): boolean {
  return s.responses.some((r) => r.personId === personId && isConsentingGo(s, r));
}

/** An active Go, given after any reset, on a version older than the current one. */
export function hasGoOnEarlierVersion(s: ProposalSnapshot, personId: string): boolean {
  return s.responses.some(
    (r) =>
      r.personId === personId &&
      r.kind === "go" &&
      active(r) &&
      r.versionNumber < s.currentVersion &&
      (s.goResetAt === null || r.createdAt > s.goResetAt),
  );
}

/** Objections that are not withdrawn, not resolved, and not followed by the objector's Go on the current version. */
export function openObjections(s: ProposalSnapshot): SnapshotResponse[] {
  return s.responses.filter(
    (objection) =>
      objection.kind === "objection" &&
      active(objection) &&
      objection.resolvedAt === null &&
      !s.responses.some(
        (go) => go.personId === objection.personId && isConsentingGo(s, go) && go.createdAt > objection.createdAt,
      ),
  );
}

/** Open objections from consent givers block a one-way decision. */
export function blockingObjections(s: ProposalSnapshot): SnapshotResponse[] {
  return openObjections(s).filter((objection) => isConsentGiver(s, objection.personId));
}

/** Unanswered questions to the proposer. */
export function openQuestions(s: ProposalSnapshot): SnapshotResponse[] {
  return s.responses.filter(
    (question) => question.kind === "question" && !s.responses.some((r) => r.kind === "answer" && r.parentId === question.id),
  );
}

/**
 * A requested person who still owes an answer in the current phase: feedback
 * in the feedback phase; in the objection round a Go or an objection (two-way),
 * or a Go on the current version unless their own objection is open (one-way
 * consent givers). Used by My tasks and the reminders.
 */
export function awaitsAnswer(s: ProposalSnapshot, personId: string): boolean {
  if (!s.participants.some((p) => p.personId === personId)) return false;
  if (s.status === "feedback") return !hasGivenFeedback(s, personId);
  if (s.status !== "objection_round") return false;
  if (s.reversibility === "two_way") return !hasAnswered(s, personId);
  return (
    isConsentGiver(s, personId) &&
    !hasGoOnCurrentVersion(s, personId) &&
    !openObjections(s).some((r) => r.personId === personId)
  );
}

export type ParticipantState = "waiting" | "feedback_given" | "go" | "go_older_version" | "objection" | "no_access";

/** Where a requested person stands in the current phase, as the list of people shows it. */
export function participantState(s: ProposalSnapshot, personId: string, hasAccess: boolean): ParticipantState {
  if (!hasAccess) return "no_access";
  if (s.status === "feedback" || s.status === "draft") return hasGivenFeedback(s, personId) ? "feedback_given" : "waiting";
  if (openObjections(s).some((r) => r.personId === personId)) return "objection";
  if (s.reversibility === "one_way" && isConsentGiver(s, personId)) {
    if (hasGoOnCurrentVersion(s, personId)) return "go";
    // A Go given under two-way rules, before the change to one-way, does not count: the person still owes a Go.
    return hasGoOnEarlierVersion(s, personId) ? "go_older_version" : "waiting";
  }
  if (s.responses.some((r) => r.personId === personId && r.kind === "go" && active(r))) return "go";
  return hasAnswered(s, personId) ? "objection" : "waiting";
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Start of the objection round. */
export function canStartObjectionRound(s: ProposalSnapshot, now: Date): Check {
  if (s.status !== "feedback") return no("The proposal is not in the feedback phase.");
  if (isDeadlinePassed(s.feedbackDeadline, now)) return ok;
  if (s.reversibility === "one_way") return no("A one-way proposal moves to the objection round after the feedback deadline.");
  const requested = requestedPeople(s);
  if (requested.length === 0) return no("Without requested people, the objection round starts after the feedback deadline.");
  if (requested.every((personId) => hasGivenFeedback(s, personId))) return ok;
  return no("The objection round starts after the feedback deadline, or once everyone asked has given feedback.");
}

export interface Criterion {
  key: string;
  label: string;
  ok: boolean;
}

/** Publish criteria. `ready_to_decide` is derived, never stored. */
export function readiness(s: ProposalSnapshot, now: Date): { ready: boolean; criteria: Criterion[] } {
  const started = s.status === "objection_round";
  const deadlinePassed = s.objectionDeadline !== null && isDeadlinePassed(s.objectionDeadline, now);
  const criteria: Criterion[] = [{ key: "started", label: "The objection round has started", ok: started }];

  if (s.reversibility === "two_way") {
    const requested = requestedPeople(s);
    const answered = requested.filter((personId) => hasAnswered(s, personId)).length;
    const allAnswered = requested.length > 0 && answered === requested.length;
    criteria.push({
      key: "deadline_or_answers",
      label:
        requested.length > 0
          ? `The objection deadline has passed, or everyone asked has answered (${answered} of ${requested.length})`
          : "The objection deadline has passed",
      ok: started && (deadlinePassed || allAnswered),
    });
  } else {
    const givers = consentGivers(s);
    const withGo = givers.filter((p) => hasGoOnCurrentVersion(s, p.personId)).length;
    criteria.push(
      { key: "deadline", label: "The objection period is over", ok: started && deadlinePassed },
      {
        key: "consent",
        label: `Every consent giver gave a Go on version ${s.currentVersion} (${withGo} of ${givers.length})`,
        ok: givers.length > 0 && withGo === givers.length,
      },
      { key: "no_blocking_objection", label: "No open objection from a consent giver", ok: blockingObjections(s).length === 0 },
      { key: "consent_access", label: "Every consent giver has access", ok: givers.every((p) => p.hasAccess) },
    );
  }
  criteria.push({ key: "decider_access", label: "The decider has access", ok: s.deciderHasAccess });
  return { ready: criteria.every((c) => c.ok), criteria };
}

/**
 * `proposal.ready_since` after a write or as time passes: when the proposal
 * last became ready to decide. A proposal that becomes ready gets `now`, and
 * its decider is told; one that stops being ready loses it, so the next time
 * counts anew. `restart` (a new decider) counts anew right away.
 */
export function nextReadySince(
  s: ProposalSnapshot,
  readySince: Date | null,
  now: Date,
  restart = false,
): { readySince: Date | null; becameReady: boolean } {
  if (!readiness(s, now).ready) return { readySince: null, becameReady: false };
  if (readySince === null || restart) return { readySince: now, becameReady: true };
  return { readySince, becameReady: false };
}

/** Two-way: objections are allowed at publish time, but the decider explains how they were addressed. */
export function objectionHandlingRequired(s: ProposalSnapshot): boolean {
  return s.reversibility === "two_way" && s.responses.some((r) => r.kind === "objection" && active(r));
}

/** The earliest allowed feedback deadline for a proposal submitted on `submittedOn`. */
export function minimumFeedbackDeadline(type: Reversibility, submittedOn: string): string {
  return addWorkingDays(submittedOn, MINIMUM_PERIODS[type].feedback);
}

export function defaultFeedbackDeadline(type: Reversibility, periods: Record<Reversibility, Periods>, today: string): string {
  return addWorkingDays(today, Math.max(periods[type].feedback, MINIMUM_PERIODS[type].feedback));
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface Permissions {
  editDraft: boolean;
  submit: boolean;
  newVersion: boolean;
  startObjectionRound: Check;
  ask: boolean;
  answer: boolean;
  giveFeedback: boolean;
  object: boolean;
  go: boolean;
  withdrawGo: boolean;
  extendFeedbackDeadline: boolean;
  extendObjectionDeadline: boolean;
  changeReversibility: boolean;
  manageParticipants: boolean;
  removeConsentGiverInObjectionRound: boolean;
  changeDecider: boolean;
  adminOverride: boolean;
  publish: boolean;
  reject: boolean;
  withdraw: boolean;
}

/** What `actor` may do on this proposal now. Commands check the same rules again. */
export function permissions(s: ProposalSnapshot, actor: Actor, now: Date): Permissions {
  const isProposer = actor.personId === s.proposerId;
  const isDecider = actor.personId === s.deciderId;
  const open = isOpen(s.status);
  const isRequested = requestedPeople(s).includes(actor.personId);
  const mayGo = s.reversibility === "one_way" ? isConsentGiver(s, actor.personId) : isRequested;
  const goGiven =
    s.reversibility === "one_way"
      ? hasGoOnCurrentVersion(s, actor.personId)
      : s.responses.some((r) => r.personId === actor.personId && r.kind === "go" && active(r));
  const objectionRound = s.status === "objection_round";

  return {
    editDraft: s.status === "draft" && isProposer,
    submit: s.status === "draft" && isProposer,
    newVersion: open && isProposer,
    startObjectionRound: isProposer ? canStartObjectionRound(s, now) : no("Only the proposer starts the objection round."),
    ask: open,
    answer: open && isProposer,
    giveFeedback: s.status === "feedback",
    object: objectionRound,
    go: objectionRound && mayGo && !goGiven,
    withdrawGo: objectionRound && goGiven,
    extendFeedbackDeadline: s.status === "feedback" && isProposer,
    extendObjectionDeadline: objectionRound && isProposer,
    changeReversibility: isProposer && open && (s.reversibility === "two_way" || s.status === "feedback"),
    manageParticipants: isProposer && open,
    removeConsentGiverInObjectionRound: objectionRound && isDecider && s.reversibility === "one_way",
    changeDecider: deciderChange(s, actor).ok,
    adminOverride: actor.isAdmin && open,
    publish: isDecider && readiness(s, now).ready,
    reject: isDecider && open,
    withdraw: isProposer && open,
  };
}

// ---------------------------------------------------------------------------
// Checks that depend on what the actor wants to change. Commands enforce them;
// the proposal page asks them what to offer.
// ---------------------------------------------------------------------------

export interface ReasonedCheck extends Check {
  /** The actor must say why (only meaningful when `ok`). */
  reasonRequired: boolean;
}

/**
 * The proposer changes the decider in the feedback phase; afterwards an
 * admin, with a reason, while the proposal is open. With `deciderId`, also
 * checks the new decider: someone other than the current one.
 */
export function deciderChange(s: ProposalSnapshot, actor: Actor, deciderId?: string): ReasonedCheck {
  let reasonRequired: boolean;
  if (actor.personId === s.proposerId && s.status === "feedback") reasonRequired = false;
  else if (actor.isAdmin && isOpen(s.status)) reasonRequired = true;
  else return { ...no("The decider cannot be changed now."), reasonRequired: false };
  if (deciderId === s.deciderId) return { ...invalidInput("deciderId", "This person is already the decider."), reasonRequired: false };
  return { ok: true, reasonRequired };
}

/** The proposer asks for consent, so they never give it. Without a field: callers name the input it is about. */
export function mayGiveConsent(proposerId: string, personId: string): Check {
  return personId === proposerId ? no("The proposer cannot be a consent giver.") : ok;
}

/**
 * Adding a person in a role: the proposer, while the proposal is open.
 * Consent givers only on a one-way proposal, never the proposer, and nobody
 * twice in the same role.
 */
export function participantAddition(s: ProposalSnapshot, actor: Actor, now: Date, target: { personId: string; role: RequestedRole }): Check {
  if (!permissions(s, actor, now).manageParticipants) return no("The proposer manages participants while the proposal is open.");
  if (target.role === "consent_giver") {
    if (s.reversibility !== "one_way") return invalidInput("role", "Only one-way proposals have consent givers.");
    const consent = mayGiveConsent(s.proposerId, target.personId);
    if (!consent.ok) return invalidInput("personId", consent.reason!);
  }
  if (s.participants.some((x) => x.personId === target.personId && x.role === target.role)) {
    return invalidInput("personId", "This person is already listed.");
  }
  return ok;
}

/** An admin replaces a consent giver in a stuck process with someone who may give consent and is not a consent giver yet. */
export function consentGiverReplacement(
  s: ProposalSnapshot,
  actor: Actor,
  now: Date,
  target: { personId: string; replacementId: string },
): Check {
  if (!permissions(s, actor, now).adminOverride) return no("Only an admin can replace a consent giver.");
  if (!isConsentGiver(s, target.personId)) return invalidInput("personId", "This person is not a consent giver.");
  if (isConsentGiver(s, target.replacementId)) return invalidInput("replacementId", "This person is already a consent giver.");
  const consent = mayGiveConsent(s.proposerId, target.replacementId);
  if (!consent.ok) return invalidInput("replacementId", consent.reason!);
  return ok;
}

/** The proposer answers each question once, while the proposal is open. */
export function questionAnswer(s: ProposalSnapshot, actor: Actor, now: Date, questionId: string): Check {
  if (!permissions(s, actor, now).answer) return no("The proposer answers questions while the proposal is open.");
  if (!s.responses.some((r) => r.id === questionId && r.kind === "question")) return invalidInput("questionId", "This question does not exist.");
  if (s.responses.some((r) => r.kind === "answer" && r.parentId === questionId)) return invalidInput("questionId", "This question has been answered.");
  return ok;
}

/** The proposer extends the deadline of the current phase; deadlines are never shortened. */
export function deadlineExtension(s: ProposalSnapshot, actor: Actor, now: Date, input: { phase: "feedback" | "objection"; deadline: string }): Check {
  const p = permissions(s, actor, now);
  const later = invalidInput("deadline", "Choose a date after the current deadline.");
  if (input.phase === "feedback") {
    if (!p.extendFeedbackDeadline) return no("The proposer extends the feedback deadline during the feedback phase.");
    return input.deadline > s.feedbackDeadline ? ok : later;
  }
  if (!p.extendObjectionDeadline) return no("The proposer extends the objection deadline during the objection round.");
  return s.objectionDeadline && input.deadline > s.objectionDeadline ? ok : later;
}

/**
 * Removing a listed person. The proposer removes feedback givers while the
 * proposal is open, and consent givers in the feedback phase. In the objection
 * round only the decider removes a consent giver, with a reason. An admin can
 * always remove someone, with a reason unless they act as the proposer in the
 * feedback phase. A consent giver with an open objection is removed only by an
 * admin, with a reason, and a one-way proposal keeps at least one consent giver.
 */
export function participantRemoval(
  s: ProposalSnapshot,
  actor: Actor,
  now: Date,
  target: { personId: string; role: RequestedRole },
): ReasonedCheck {
  const refused = (check: Check): ReasonedCheck => ({ ...check, reasonRequired: false });
  if (!s.participants.some((x) => x.personId === target.personId && x.role === target.role)) {
    return refused(invalidInput("personId", "This person is not listed."));
  }
  const p = permissions(s, actor, now);
  if (target.role === "feedback_giver") {
    if (!p.manageParticipants && !p.adminOverride) return refused(no("The proposer manages participants while the proposal is open."));
    return { ok: true, reasonRequired: false };
  }

  const byProposer = p.manageParticipants && s.status === "feedback";
  const byDecider = p.removeConsentGiverInObjectionRound;
  if (!byProposer && !byDecider && !p.adminOverride) return refused(no("In the objection round, only the decider can remove a consent giver."));
  const hasOpenObjection = openObjections(s).some((r) => r.personId === target.personId);
  if (hasOpenObjection && !p.adminOverride) {
    return refused(invalidInput("personId", "This person has an open objection. Only an admin can remove them, with a reason."));
  }
  if (s.participants.filter((x) => x.role === "consent_giver").length === 1) {
    return refused(invalidInput("personId", "A one-way proposal needs a consent giver. Add another one first."));
  }
  return { ok: true, reasonRequired: byDecider || (p.adminOverride && !byProposer) || hasOpenObjection };
}

/** The person who raised an objection marks it resolved while the proposal is open. */
export function objectionResolution(s: ProposalSnapshot, actor: Actor, responseId: string): Check {
  const objection = s.responses.find((r) => r.id === responseId && r.kind === "objection");
  if (!objection) return invalidInput("responseId", "This objection does not exist.");
  if (objection.personId !== actor.personId) return no("Only the person who raised an objection can resolve it.");
  if (!isOpen(s.status)) return no("The proposal is closed.");
  if (objection.resolvedAt || objection.withdrawnAt) return invalidInput("responseId", "This objection is already resolved.");
  return ok;
}
