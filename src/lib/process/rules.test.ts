import { describe, expect, it } from "vitest";
import {
  blockingObjections,
  canStartObjectionRound,
  consentGiverReplacement,
  deadlineExtension,
  deciderChange,
  mayGiveConsent,
  minimumFeedbackDeadline,
  nextReadySince,
  objectionHandlingRequired,
  objectionResolution,
  participantAddition,
  participantRemoval,
  participantState,
  permissions,
  questionAnswer,
  readiness,
  type ParticipantState,
  type ProposalSnapshot,
  type ReasonedCheck,
  type SnapshotResponse,
} from "./rules";

// Wednesday 2026-11-04, 10:00 in Amsterdam.
const NOW = new Date("2026-11-04T09:00:00Z");
const PAST = "2026-11-03";
const FUTURE = "2026-11-06";

const PROPOSER = "proposer";
const DECIDER = "decider";
const ANA = "ana";
const BEN = "ben";
const OTHER = "other";

let sequence = 0;
function response(personId: string, kind: SnapshotResponse["kind"], extra: Partial<SnapshotResponse> = {}): SnapshotResponse {
  sequence += 1;
  return {
    id: `r${sequence}`,
    personId,
    kind,
    versionNumber: 1,
    createdAt: new Date(Date.UTC(2026, 10, 3, 8, sequence)),
    resolvedAt: null,
    withdrawnAt: null,
    parentId: null,
    ...extra,
  };
}

function snapshot(overrides: Partial<ProposalSnapshot> = {}): ProposalSnapshot {
  return {
    status: "objection_round",
    reversibility: "two_way",
    proposerId: PROPOSER,
    deciderId: DECIDER,
    deciderHasAccess: true,
    submittedOn: "2026-10-28",
    feedbackDeadline: PAST,
    objectionPeriodDays: 1,
    objectionRoundStartedAt: new Date("2026-11-03T08:00:00Z"),
    objectionDeadline: FUTURE,
    currentVersion: 1,
    goResetAt: null,
    participants: [],
    responses: [],
    ...overrides,
  };
}

const feedbackGivers = [
  { personId: ANA, role: "feedback_giver" as const, hasAccess: true },
  { personId: BEN, role: "feedback_giver" as const, hasAccess: true },
];
const consentGivers = [
  { personId: ANA, role: "consent_giver" as const, hasAccess: true },
  { personId: BEN, role: "consent_giver" as const, hasAccess: true },
];

const actor = (personId: string, isAdmin = false) => ({ personId, isAdmin });

describe("start of the objection round", () => {
  const cases: [string, Partial<ProposalSnapshot>, boolean][] = [
    ["two-way, before the deadline, nobody asked", { reversibility: "two_way", feedbackDeadline: FUTURE }, false],
    ["two-way, after the deadline, nobody asked", { reversibility: "two_way", feedbackDeadline: PAST }, true],
    [
      "two-way, before the deadline, everyone asked gave feedback",
      { reversibility: "two_way", feedbackDeadline: FUTURE, participants: feedbackGivers, responses: [response(ANA, "feedback"), response(BEN, "feedback")] },
      true,
    ],
    [
      "two-way, before the deadline, one requested person is missing",
      { reversibility: "two_way", feedbackDeadline: FUTURE, participants: feedbackGivers, responses: [response(ANA, "feedback")] },
      false,
    ],
    [
      "one-way, before the deadline, even with all feedback",
      { reversibility: "one_way", feedbackDeadline: FUTURE, participants: consentGivers, responses: [response(ANA, "feedback"), response(BEN, "feedback")] },
      false,
    ],
    ["one-way, after the deadline", { reversibility: "one_way", feedbackDeadline: PAST, participants: consentGivers }, true],
    ["not in the feedback phase", { status: "objection_round", feedbackDeadline: PAST }, false],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    expect(canStartObjectionRound(snapshot({ status: "feedback", objectionRoundStartedAt: null, objectionDeadline: null, ...overrides }), NOW).ok).toBe(expected);
  });

  it("uses the end of the deadline day in the server's time zone", () => {
    const s = snapshot({ status: "feedback", feedbackDeadline: "2026-11-04", objectionRoundStartedAt: null, objectionDeadline: null });
    expect(canStartObjectionRound(s, new Date("2026-11-04T22:59:00Z")).ok).toBe(false);
    expect(canStartObjectionRound(s, new Date("2026-11-04T23:00:00Z")).ok).toBe(true);
  });
});

describe("readiness of a two-way decision", () => {
  const cases: [string, Partial<ProposalSnapshot>, boolean][] = [
    ["feedback phase", { status: "feedback" }, false],
    ["objection round, deadline ahead, nobody asked", { objectionDeadline: FUTURE }, false],
    ["objection round, deadline passed, nobody asked", { objectionDeadline: PAST }, true],
    [
      "deadline ahead, everyone asked answered with Go or objection",
      { objectionDeadline: FUTURE, participants: feedbackGivers, responses: [response(ANA, "go"), response(BEN, "objection")] },
      true,
    ],
    [
      "deadline ahead, one person asked has not answered",
      { objectionDeadline: FUTURE, participants: feedbackGivers, responses: [response(ANA, "go")] },
      false,
    ],
    [
      "deadline ahead, a withdrawn Go does not count",
      { objectionDeadline: FUTURE, participants: feedbackGivers, responses: [response(ANA, "go"), response(BEN, "go", { withdrawnAt: NOW })] },
      false,
    ],
    ["no answer by the deadline counts as no objection", { objectionDeadline: PAST, participants: feedbackGivers }, true],
    ["open objections do not block", { objectionDeadline: PAST, responses: [response(OTHER, "objection")] }, true],
    ["the decider lost access", { objectionDeadline: PAST, deciderHasAccess: false }, false],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    expect(readiness(snapshot({ reversibility: "two_way", ...overrides }), NOW).ready).toBe(expected);
  });
});

describe("when a proposal became ready to decide (ready_since)", () => {
  const EARLIER = new Date("2026-11-03T12:00:00Z");
  const ready = { reversibility: "two_way" as const, objectionDeadline: PAST };
  const notReady = { reversibility: "two_way" as const, objectionDeadline: FUTURE, participants: feedbackGivers };
  // [case, snapshot, ready_since before, restart, ready_since after, decider told]
  const cases: [string, Partial<ProposalSnapshot>, Date | null, boolean, Date | null, boolean][] = [
    ["becomes ready", ready, null, false, NOW, true],
    ["stays ready", ready, EARLIER, false, EARLIER, false],
    ["stops being ready, so the next time counts anew", notReady, EARLIER, false, null, false],
    ["stays not ready", notReady, null, false, null, false],
    ["a new decider of a ready proposal is told", ready, EARLIER, true, NOW, true],
    ["a new decider of a proposal that is not ready", notReady, EARLIER, true, null, false],
    ["the feedback phase is never ready", { status: "feedback" }, null, false, null, false],
    ["a decided proposal is no longer ready", { ...ready, status: "decided" }, EARLIER, false, null, false],
  ];
  it.each(cases)("%s", (_name, overrides, before, restart, after, told) => {
    expect(nextReadySince(snapshot(overrides), before, NOW, restart)).toEqual({ readySince: after, becameReady: told });
  });
});

describe("readiness of a one-way decision", () => {
  const allGo = [response(ANA, "go"), response(BEN, "go")];
  const cases: [string, Partial<ProposalSnapshot>, boolean][] = [
    ["every consent giver gave a Go, period over", { responses: allGo }, true],
    ["every Go, but the objection period is not over", { objectionDeadline: FUTURE, responses: allGo }, false],
    ["no answer by the deadline does not count as a Go", { responses: [response(ANA, "go")] }, false],
    [
      "a Go on an older version does not count",
      { currentVersion: 2, responses: [response(ANA, "go", { versionNumber: 2 }), response(BEN, "go", { versionNumber: 1 })] },
      false,
    ],
    ["a withdrawn Go does not count", { responses: [response(ANA, "go"), response(BEN, "go", { withdrawnAt: NOW })] }, false],
    ["an open objection from a consent giver blocks", { responses: [...allGo, response(BEN, "objection")] }, false],
    [
      "a resolved objection does not block",
      { responses: [response(ANA, "go"), response(BEN, "objection", { resolvedAt: NOW }), response(BEN, "go")] },
      true,
    ],
    [
      "a later Go on the current version clears the objector's objection",
      { currentVersion: 2, responses: [response(BEN, "objection"), response(ANA, "go", { versionNumber: 2 }), response(BEN, "go", { versionNumber: 2 })] },
      true,
    ],
    ["an objection from someone else does not block", { responses: [...allGo, response(OTHER, "objection")] }, true],
    [
      "a consent giver without access must be replaced",
      { participants: [consentGivers[0]!, { ...consentGivers[1]!, hasAccess: false }], responses: allGo },
      false,
    ],
    ["without consent givers, nothing can be published", { participants: [], responses: [] }, false],
    [
      "a Go given before the proposal became one-way does not count",
      { goResetAt: new Date(Date.UTC(2026, 10, 3, 12)), responses: allGo },
      false,
    ],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    expect(readiness(snapshot({ reversibility: "one_way", objectionDeadline: PAST, participants: consentGivers, ...overrides }), NOW).ready).toBe(expected);
  });

  it("lists the open objections that block", () => {
    const s = snapshot({ reversibility: "one_way", participants: consentGivers, responses: [response(BEN, "objection"), response(OTHER, "objection")] });
    expect(blockingObjections(s).map((r) => r.personId)).toEqual([BEN]);
  });
});

describe("objections at publish time", () => {
  it("require an explanation for two-way decisions", () => {
    expect(objectionHandlingRequired(snapshot({ responses: [response(OTHER, "objection")] }))).toBe(true);
    expect(objectionHandlingRequired(snapshot({ responses: [response(OTHER, "objection", { withdrawnAt: NOW })] }))).toBe(false);
    expect(objectionHandlingRequired(snapshot({ responses: [] }))).toBe(false);
    expect(objectionHandlingRequired(snapshot({ reversibility: "one_way", responses: [response(OTHER, "objection")] }))).toBe(false);
  });
});

describe("minimum feedback deadline", () => {
  it("is 1 working day for two-way and 5 for one-way", () => {
    expect(minimumFeedbackDeadline("two_way", "2026-11-06")).toBe("2026-11-09");
    expect(minimumFeedbackDeadline("one_way", "2026-11-04")).toBe("2026-11-11");
  });
});

describe("permissions", () => {
  it("let only consent givers give a Go on one-way proposals", () => {
    const s = snapshot({ reversibility: "one_way", participants: consentGivers });
    expect(permissions(s, actor(ANA), NOW).go).toBe(true);
    expect(permissions(s, actor(OTHER), NOW).go).toBe(false);
    expect(permissions(s, actor(OTHER), NOW).object).toBe(true);
  });

  it("ask a consent giver to confirm again after a new version", () => {
    const s = snapshot({ reversibility: "one_way", currentVersion: 2, participants: consentGivers, responses: [response(ANA, "go")] });
    expect(permissions(s, actor(ANA), NOW).go).toBe(true);
    const confirmed = snapshot({ ...s, responses: [response(ANA, "go", { versionNumber: 2 })] });
    expect(permissions(confirmed, actor(ANA), NOW)).toMatchObject({ go: false, withdrawGo: true });
  });

  it("let requested people answer two-way proposals with a Go", () => {
    const s = snapshot({ reversibility: "two_way", participants: feedbackGivers });
    expect(permissions(s, actor(ANA), NOW).go).toBe(true);
    expect(permissions(s, actor(OTHER), NOW).go).toBe(false);
  });

  it("let the decider publish only when ready, and reject while open", () => {
    expect(permissions(snapshot({ objectionDeadline: FUTURE }), actor(DECIDER), NOW)).toMatchObject({ publish: false, reject: true });
    expect(permissions(snapshot({ objectionDeadline: PAST }), actor(DECIDER), NOW)).toMatchObject({ publish: true, reject: true });
    expect(permissions(snapshot({ objectionDeadline: PAST }), actor(PROPOSER), NOW)).toMatchObject({ publish: false, reject: false, withdraw: true });
  });

  it("allow one-way to two-way only in the feedback phase; two-way to one-way until publication", () => {
    expect(permissions(snapshot({ reversibility: "one_way", status: "objection_round" }), actor(PROPOSER), NOW).changeReversibility).toBe(false);
    expect(permissions(snapshot({ reversibility: "one_way", status: "feedback" }), actor(PROPOSER), NOW).changeReversibility).toBe(true);
    expect(permissions(snapshot({ reversibility: "two_way", status: "objection_round" }), actor(PROPOSER), NOW).changeReversibility).toBe(true);
    expect(permissions(snapshot({ status: "decided" }), actor(PROPOSER), NOW).changeReversibility).toBe(false);
  });

  it("let the proposer change the decider in the feedback phase, afterwards only an admin", () => {
    expect(permissions(snapshot({ status: "feedback" }), actor(PROPOSER), NOW).changeDecider).toBe(true);
    expect(permissions(snapshot({ status: "objection_round" }), actor(PROPOSER), NOW).changeDecider).toBe(false);
    expect(permissions(snapshot({ status: "objection_round" }), actor(OTHER, true), NOW).changeDecider).toBe(true);
  });

  it("allow nothing on closed proposals", () => {
    const p = permissions(snapshot({ status: "decided" }), actor(PROPOSER), NOW);
    expect(Object.entries(p).filter(([, value]) => value === true)).toEqual([]);
  });
});

describe("removing a listed person", () => {
  const oneWay = (overrides: Partial<ProposalSnapshot> = {}) => snapshot({ reversibility: "one_way", participants: consentGivers, ...overrides });
  const feedback = { status: "feedback" as const, objectionRoundStartedAt: null, objectionDeadline: null, feedbackDeadline: FUTURE };
  const objectionByAna = { responses: [response(ANA, "objection")] };
  const cases: [string, ProposalSnapshot, ReturnType<typeof actor>, { personId: string; role: "consent_giver" | "feedback_giver" }, Partial<ReasonedCheck>][] = [
    ["the proposer, a feedback giver while open", snapshot({ participants: feedbackGivers }), actor(PROPOSER), { personId: ANA, role: "feedback_giver" }, { ok: true, reasonRequired: false }],
    ["the proposer, a consent giver in feedback", oneWay(feedback), actor(PROPOSER), { personId: ANA, role: "consent_giver" }, { ok: true, reasonRequired: false }],
    ["the proposer, the last consent giver", oneWay({ ...feedback, participants: consentGivers.slice(0, 1) }), actor(PROPOSER), { personId: ANA, role: "consent_giver" }, { ok: false, field: "personId" }],
    ["the proposer, a consent giver in the objection round", oneWay(), actor(PROPOSER), { personId: ANA, role: "consent_giver" }, { ok: false, field: undefined }],
    ["the decider in the objection round, with a reason", oneWay(), actor(DECIDER), { personId: ANA, role: "consent_giver" }, { ok: true, reasonRequired: true }],
    ["the decider, a consent giver with an open objection", oneWay(objectionByAna), actor(DECIDER), { personId: ANA, role: "consent_giver" }, { ok: false, field: "personId" }],
    ["an admin, a consent giver with an open objection, with a reason", oneWay({ ...feedback, ...objectionByAna }), actor(OTHER, true), { personId: ANA, role: "consent_giver" }, { ok: true, reasonRequired: true }],
    ["an admin who is the proposer, in the objection round, with a reason", oneWay(), actor(PROPOSER, true), { personId: ANA, role: "consent_giver" }, { ok: true, reasonRequired: true }],
    ["an admin who is the proposer, in feedback, without a reason", oneWay(feedback), actor(PROPOSER, true), { personId: ANA, role: "consent_giver" }, { ok: true, reasonRequired: false }],
    ["someone else", snapshot({ participants: feedbackGivers }), actor(OTHER), { personId: ANA, role: "feedback_giver" }, { ok: false, field: undefined }],
    ["nobody once the proposal is closed", snapshot({ status: "decided", participants: feedbackGivers }), actor(PROPOSER), { personId: ANA, role: "feedback_giver" }, { ok: false }],
    ["nobody who is not listed", snapshot({ participants: feedbackGivers }), actor(PROPOSER), { personId: OTHER, role: "feedback_giver" }, { ok: false, field: "personId" }],
  ];
  it.each(cases)("%s", (_, s, who, target, expected) => {
    // `field: undefined`: refused outright, not because of the input.
    expect({ field: undefined, ...participantRemoval(s, who, NOW, target) }).toMatchObject(expected);
  });
});

describe("resolving an objection", () => {
  const objection = response(ANA, "objection");
  it.each([
    ["by the objector while the proposal is open", snapshot({ responses: [objection] }), ANA, { ok: true }],
    ["by someone else", snapshot({ responses: [objection] }), BEN, { ok: false, field: undefined }],
    ["once the proposal is decided", snapshot({ status: "decided", responses: [objection] }), ANA, { ok: false, reason: "The proposal is closed." }],
    ["twice", snapshot({ responses: [{ ...objection, resolvedAt: NOW }] }), ANA, { ok: false, field: "responseId" }],
  ] as const)("%s", (_, s, personId, expected) => {
    expect({ field: undefined, ...objectionResolution(s, actor(personId), objection.id) }).toMatchObject(expected);
  });

  it("refuses an id that is not an objection", () => {
    expect(objectionResolution(snapshot({ responses: [objection] }), actor(ANA), "missing")).toMatchObject({ ok: false, field: "responseId" });
  });
});

describe("changing the decider", () => {
  it.each([
    ["the proposer in feedback, without a reason", "feedback", actor(PROPOSER), { ok: true, reasonRequired: false }],
    ["an admin who is the proposer, in feedback, without a reason", "feedback", actor(PROPOSER, true), { ok: true, reasonRequired: false }],
    ["an admin in feedback, with a reason", "feedback", actor(OTHER, true), { ok: true, reasonRequired: true }],
    ["the proposer in the objection round: not at all", "objection_round", actor(PROPOSER), { ok: false }],
    ["an admin in the objection round, with a reason", "objection_round", actor(OTHER, true), { ok: true, reasonRequired: true }],
    ["an admin once the proposal is decided: not at all", "decided", actor(OTHER, true), { ok: false }],
  ] as const)("%s", (_, status, who, expected) => {
    expect(deciderChange(snapshot({ status }), who)).toMatchObject(expected);
  });

  it("checks the new decider: anyone but the current one", () => {
    const s = snapshot({ status: "feedback" });
    expect(deciderChange(s, actor(PROPOSER), ANA)).toEqual({ ok: true, reasonRequired: false });
    expect(deciderChange(s, actor(PROPOSER), DECIDER)).toMatchObject({ ok: false, field: "deciderId", reason: "This person is already the decider." });
    expect(deciderChange(s, actor(OTHER), DECIDER)).toMatchObject({ ok: false, reason: "The decider cannot be changed now." });
  });
});

describe("who may give consent", () => {
  it("anyone but the proposer", () => {
    expect(mayGiveConsent(PROPOSER, ANA)).toEqual({ ok: true });
    expect(mayGiveConsent(PROPOSER, PROPOSER)).toEqual({ ok: false, reason: "The proposer cannot be a consent giver." });
  });
});

describe("adding a person", () => {
  const feedback = { status: "feedback" as const, objectionRoundStartedAt: null, objectionDeadline: null, feedbackDeadline: FUTURE };
  const oneWay = snapshot({ ...feedback, reversibility: "one_way", participants: consentGivers.slice(0, 1) });
  const twoWay = snapshot({ ...feedback, participants: feedbackGivers.slice(0, 1) });
  type Role = "consent_giver" | "feedback_giver";
  const cases: [string, ProposalSnapshot, ReturnType<typeof actor>, { personId: string; role: Role }, Partial<ReturnType<typeof participantAddition>>][] = [
    ["the proposer asks someone for feedback", twoWay, actor(PROPOSER), { personId: BEN, role: "feedback_giver" }, { ok: true }],
    ["the proposer adds a consent giver to a one-way proposal", oneWay, actor(PROPOSER), { personId: BEN, role: "consent_giver" }, { ok: true }],
    ["a consent giver can also give feedback", oneWay, actor(PROPOSER), { personId: ANA, role: "feedback_giver" }, { ok: true }],
    ["no consent givers on a two-way proposal", twoWay, actor(PROPOSER), { personId: BEN, role: "consent_giver" }, { ok: false, field: "role" }],
    ["never the proposer as consent giver", oneWay, actor(PROPOSER), { personId: PROPOSER, role: "consent_giver" }, { ok: false, field: "personId", reason: "The proposer cannot be a consent giver." }],
    ["nobody twice in one role", twoWay, actor(PROPOSER), { personId: ANA, role: "feedback_giver" }, { ok: false, field: "personId", reason: "This person is already listed." }],
    ["only the proposer", twoWay, actor(OTHER, true), { personId: BEN, role: "feedback_giver" }, { ok: false, field: undefined }],
    ["not once the proposal is closed", snapshot({ status: "decided" }), actor(PROPOSER), { personId: BEN, role: "feedback_giver" }, { ok: false, field: undefined }],
  ];
  it.each(cases)("%s", (_, s, who, target, expected) => {
    expect({ field: undefined, ...participantAddition(s, who, NOW, target) }).toMatchObject(expected);
  });
});

describe("replacing a consent giver", () => {
  const s = snapshot({ reversibility: "one_way", participants: consentGivers });
  const cases: [string, ReturnType<typeof actor>, { personId: string; replacementId: string }, Partial<ReturnType<typeof consentGiverReplacement>>][] = [
    ["an admin, with someone new", actor(OTHER, true), { personId: ANA, replacementId: OTHER }, { ok: true }],
    ["only an admin", actor(PROPOSER), { personId: ANA, replacementId: OTHER }, { ok: false, field: undefined }],
    ["only a consent giver", actor(OTHER, true), { personId: DECIDER, replacementId: OTHER }, { ok: false, field: "personId" }],
    ["not with another consent giver", actor(OTHER, true), { personId: ANA, replacementId: BEN }, { ok: false, field: "replacementId", reason: "This person is already a consent giver." }],
    ["never with the proposer", actor(OTHER, true), { personId: ANA, replacementId: PROPOSER }, { ok: false, field: "replacementId", reason: "The proposer cannot be a consent giver." }],
  ];
  it.each(cases)("%s", (_, who, target, expected) => {
    expect({ field: undefined, ...consentGiverReplacement(s, who, NOW, target) }).toMatchObject(expected);
  });
});

describe("answering a question", () => {
  const question = response(ANA, "question");
  const answered = snapshot({ responses: [question, response(PROPOSER, "answer", { parentId: question.id })] });
  it.each([
    ["the proposer, while the proposal is open", snapshot({ responses: [question] }), PROPOSER, question.id, { ok: true }],
    ["only the proposer", snapshot({ responses: [question] }), ANA, question.id, { ok: false, field: undefined }],
    ["not once the proposal is closed", snapshot({ status: "decided", responses: [question] }), PROPOSER, question.id, { ok: false, field: undefined }],
    ["only a question", snapshot({ responses: [question] }), PROPOSER, "unknown", { ok: false, field: "questionId", reason: "This question does not exist." }],
    ["only once", answered, PROPOSER, question.id, { ok: false, field: "questionId", reason: "This question has been answered." }],
  ] as const)("%s", (_, s, personId, questionId, expected) => {
    expect({ field: undefined, ...questionAnswer(s, actor(personId), NOW, questionId) }).toMatchObject(expected);
  });
});

describe("extending a deadline", () => {
  const feedback = snapshot({ status: "feedback", objectionRoundStartedAt: null, objectionDeadline: null, feedbackDeadline: FUTURE });
  const round = snapshot({ objectionDeadline: FUTURE });
  const LATER = "2026-11-10";
  it.each([
    ["the feedback deadline, later", feedback, PROPOSER, "feedback", LATER, { ok: true }],
    ["the feedback deadline, never earlier or the same", feedback, PROPOSER, "feedback", FUTURE, { ok: false, field: "deadline" }],
    ["the feedback deadline only in the feedback phase", round, PROPOSER, "feedback", LATER, { ok: false, field: undefined }],
    ["the objection deadline, later", round, PROPOSER, "objection", LATER, { ok: true }],
    ["the objection deadline, never earlier", round, PROPOSER, "objection", PAST, { ok: false, field: "deadline" }],
    ["the objection deadline only in the objection round", feedback, PROPOSER, "objection", LATER, { ok: false, field: undefined }],
    ["only the proposer", feedback, ANA, "feedback", LATER, { ok: false, field: undefined }],
  ] as const)("%s", (_, s, personId, phase, deadline, expected) => {
    expect({ field: undefined, ...deadlineExtension(s, actor(personId), NOW, { phase, deadline }) }).toMatchObject(expected);
  });
});

describe("participant state", () => {
  const oneWay = (overrides: Partial<ProposalSnapshot>) => snapshot({ reversibility: "one_way", participants: consentGivers, ...overrides });
  const resetAt = new Date("2026-11-03T12:00:00Z");
  const cases: [string, ProposalSnapshot, string, boolean, ParticipantState][] = [
    ["no access", oneWay({}), ANA, false, "no_access"],
    ["feedback given", snapshot({ status: "feedback", participants: feedbackGivers, responses: [response(ANA, "feedback")] }), ANA, true, "feedback_given"],
    ["a Go on the current version", oneWay({ responses: [response(ANA, "go")] }), ANA, true, "go"],
    ["a Go on an older version", oneWay({ currentVersion: 2, responses: [response(ANA, "go")] }), ANA, true, "go_older_version"],
    // The Go was given under two-way rules, before the change to one-way.
    ["a Go from before the change to one-way", oneWay({ goResetAt: resetAt, responses: [response(ANA, "go")] }), ANA, true, "waiting"],
    ["an open objection", oneWay({ responses: [response(ANA, "objection")] }), ANA, true, "objection"],
    ["a two-way Go", snapshot({ participants: feedbackGivers, responses: [response(ANA, "go")] }), ANA, true, "go"],
    ["nothing yet", oneWay({}), BEN, true, "waiting"],
  ];
  it.each(cases)("%s", (_, s, personId, hasAccess, expected) => {
    expect(participantState(s, personId, hasAccess)).toBe(expected);
  });
});
