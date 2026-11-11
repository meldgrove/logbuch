import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { asc } from "drizzle-orm";
import { auditEvent, entry, notificationDelivery, outcome, participant, person, proposal, proposalVersion, response, webhookState } from "@/lib/db/schema";
import { logDecision, EntryError } from "@/lib/entries/commands";
import { decisionInputSchema } from "@/lib/entries/schemas";
import {
  addParticipant,
  addVersion,
  answerQuestion,
  changeDecider,
  changeReversibility,
  discardDraft,
  extendDeadline,
  giveGo,
  postResponse,
  publishDecision,
  rejectProposal,
  removeParticipant,
  replaceConsentGiver,
  resolveObjection,
  saveDraft,
  startObjectionRound,
  submitProposal,
  withdrawGo,
  withdrawProposal,
} from "./commands";
import { readiness, type Actor } from "./rules";
import { proposalDraftSchema, publishSchema, type ProposalDraftInput } from "./schemas";
import { setDefaultPeriods } from "./settings";
import { getProposalView } from "./queries";
import { loadProposal } from "./snapshot";

const testDb = connectTestDatabase();
const { db } = testDb;
let seed: Awaited<ReturnType<typeof seedDirectory>>;
let ada: Actor; // proposer
let dan: Actor; // decider
let amy: Actor; // admin, consent giver or feedback giver
let eve: Actor; // second consent giver

// Wednesday, 2026-11-04.
const MONDAY = new Date("2026-11-02T09:00:00Z");
const WEDNESDAY = new Date("2026-11-04T09:00:00Z");
const at = (date: string) => new Date(`${date}T09:00:00Z`);

beforeEach(async () => {
  await testDb.reset();
  seed = await seedDirectory(db);
  const [eveRow] = await db
    .insert(person)
    .values({ oidcSubject: "sub-eve", displayName: "Eve Expert", teamId: seed.teams.tech.id, hasAccess: true })
    .returning();
  ada = seed.actors.ada;
  dan = seed.actors.dan;
  amy = seed.actors.amy;
  eve = { personId: eveRow!.id, isAdmin: false };
});
afterAll(() => testDb.close());

function draftInput(overrides: Partial<Record<keyof ProposalDraftInput, unknown>> = {}): ProposalDraftInput {
  return proposalDraftSchema.parse({
    title: "Four-day week for the tech team",
    question: "Should the tech team try a four-day week?",
    body: "Focus time is scarce.",
    impact: "medium",
    proposalText: "We try a four-day week for three months.",
    reversibility: "two_way",
    deciderId: seed.people.dan.id,
    feedbackGiverIds: [seed.people.amy.id],
    teamId: seed.teams.tech.id,
    objectionPeriodDays: "1",
    feedbackDeadline: "2026-11-06",
    ...overrides,
  });
}

const oneWay = (overrides: Partial<Record<keyof ProposalDraftInput, unknown>> = {}) =>
  draftInput({
    reversibility: "one_way",
    reversibilityReason: "Contracts would change.",
    consentGiverIds: [seed.people.amy.id, eve.personId],
    feedbackGiverIds: [],
    feedbackDeadline: "2026-11-11",
    objectionPeriodDays: "3",
    ...overrides,
  });

async function submitted(input: ProposalDraftInput, now = WEDNESDAY) {
  const draft = await saveDraft(db, ada, input, undefined, now);
  await submitProposal(db, ada, draft.id, now);
  return draft;
}

async function expectError(promise: Promise<unknown>, code: EntryError["code"], field?: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error, "expected an EntryError").toBeInstanceOf(EntryError);
  expect((error as EntryError).code).toBe(code);
  if (field) expect(Object.keys((error as EntryError).fieldErrors)).toContain(field);
  return error as EntryError;
}

async function state(entryId: string, now = WEDNESDAY) {
  const loaded = (await loadProposal(db, entryId))!;
  return { ...loaded, readiness: readiness(loaded.snapshot, now) };
}

describe("drafts", () => {
  it("are saved, edited, and discarded without leaving rows behind", async () => {
    const draft = await saveDraft(db, ada, draftInput({ body: "", impact: "" }), undefined, WEDNESDAY);
    await saveDraft(db, ada, draftInput({ title: "Renamed" }), draft.id, WEDNESDAY);
    expect((await state(draft.id)).entry).toMatchObject({ status: "draft", title: "Renamed" });
    await expectError(saveDraft(db, dan, draftInput(), draft.id, WEDNESDAY), "forbidden");

    await discardDraft(db, ada, draft.id);
    expect(await db.select().from(entry)).toHaveLength(0);
    expect(await db.select().from(participant)).toHaveLength(0);
    expect(await db.select().from(auditEvent)).toHaveLength(0);
  });

  it("are checked completely on submit", async () => {
    const draft = await saveDraft(
      db,
      ada,
      oneWay({ body: "", impact: "", reversibilityReason: "", consentGiverIds: [], feedbackDeadline: "2026-11-06" }),
      undefined,
      WEDNESDAY,
    );
    const error = await expectError(submitProposal(db, ada, draft.id, WEDNESDAY), "invalid");
    expect(Object.keys(error.fieldErrors).sort()).toEqual(["body", "consentGiverIds", "feedbackDeadline", "impact", "reversibilityReason"]);
  });

  it("let a person be consent giver and feedback giver at once (once per role)", async () => {
    const draft = await saveDraft(db, ada, oneWay({ consentGiverIds: [amy.personId], feedbackGiverIds: [amy.personId] }), undefined, WEDNESDAY);
    await submitProposal(db, ada, draft.id, WEDNESDAY);
    expect((await state(draft.id)).snapshot.participants.map((p) => p.role).sort()).toEqual(["consent_giver", "feedback_giver"]);
  });

  it("cannot have the proposer as consent giver", async () => {
    await expectError(saveDraft(db, ada, oneWay({ consentGiverIds: [seed.people.ada.id] }), undefined, WEDNESDAY), "invalid", "consentGiverIds");
  });

  it("take the question as the summary when there is none, shortened to fit", async () => {
    const question = `${"Should we ".repeat(29)}try?`;
    const draft = await saveDraft(db, ada, draftInput({ question }), undefined, WEDNESDAY);
    const { summary } = (await state(draft.id)).entry;
    expect(summary).toHaveLength(280);
    expect(summary.endsWith("…")).toBe(true);
    await saveDraft(db, ada, draftInput({ question, summary: "Try a four-day week." }), draft.id, WEDNESDAY);
    expect((await state(draft.id)).entry.summary).toBe("Try a four-day week.");
  });

  it("use the admin's default periods for the feedback deadline", async () => {
    await setDefaultPeriods(db, amy.personId, { two_way: { feedback: 4, objection: 2 }, one_way: { feedback: 6, objection: 3 } });
    const draft = await saveDraft(db, ada, draftInput({ feedbackDeadline: "" }), undefined, WEDNESDAY);
    expect((await state(draft.id)).proposal.feedbackDeadline).toBe("2026-11-10");
  });
});

describe("a two-way proposal", () => {
  it("goes from feedback to an early objection round to a published decision", async () => {
    const draft = await submitted(draftInput());
    expect((await state(draft.id)).entry.status).toBe("feedback");

    await expectError(startObjectionRound(db, ada, draft.id, WEDNESDAY), "invalid");
    await postResponse(db, amy, draft.id, { kind: "feedback", text: "Good idea." }, WEDNESDAY);
    const deadline = await startObjectionRound(db, ada, draft.id, WEDNESDAY);
    expect(deadline).toBe("2026-11-05");

    await giveGo(db, amy, draft.id, { version: 1 }, WEDNESDAY);
    const ready = await state(draft.id);
    expect(ready.readiness.ready).toBe(true);

    await expectError(publishDecision(db, ada, draft.id, publish(), WEDNESDAY), "forbidden");
    await publishDecision(db, dan, draft.id, publish(), WEDNESDAY);
    const [result] = await db.select().from(outcome).where(eq(outcome.entryId, draft.id));
    expect(result).toMatchObject({ result: "adopted", decidedById: dan.personId, decidedOn: "2026-11-04" });
    const decided = await state(draft.id);
    expect(decided.entry).toMatchObject({
      type: "decision",
      status: "decided",
      summary: "The tech team tries a four-day week for three months.",
      rationale: "Focus time matters.",
      body: "Focus time is scarce.",
      impact: "medium",
    });
    expect(decided.decision).toMatchObject({ howDecided: "integrative_process", reversibility: "two_way", deciderId: dan.personId });
  });

  it("needs an explanation of open objections at publish time", async () => {
    const draft = await submitted(draftInput({ feedbackGiverIds: [] }));
    await startObjectionRound(db, ada, draft.id, at("2026-11-09"));
    await postResponse(db, eve, draft.id, { kind: "objection", text: "Customers need Friday support." }, at("2026-11-09"));
    const after = at("2026-11-11");
    await expectError(publishDecision(db, dan, draft.id, publish(), after), "invalid", "objectionHandling");
    await publishDecision(db, dan, draft.id, publish({ objectionHandling: "Support rota covers Fridays." }), after);
    expect((await state(draft.id)).entry.status).toBe("decided");
  });

  it("can only be rejected by the decider and withdrawn by the proposer", async () => {
    const first = await submitted(draftInput());
    await expectError(rejectProposal(db, ada, first.id, { rationale: "No." }, WEDNESDAY), "forbidden");
    await rejectProposal(db, dan, first.id, { rationale: "Not now." }, WEDNESDAY);
    expect((await state(first.id)).entry).toMatchObject({ status: "rejected", rationale: "Not now." });
    await expectError(postResponse(db, amy, first.id, { kind: "question", text: "Why?" }, WEDNESDAY), "forbidden");

    const second = await submitted(draftInput());
    await expectError(withdrawProposal(db, dan, second.id, {}, WEDNESDAY), "forbidden");
    await withdrawProposal(db, ada, second.id, { reason: "Superseded by a team decision." }, WEDNESDAY);
    expect((await state(second.id)).entry.status).toBe("withdrawn");
  });
});

describe("a one-way proposal", () => {
  it("starts the objection round only after the feedback deadline", async () => {
    const draft = await submitted(oneWay());
    await postResponse(db, amy, draft.id, { kind: "feedback", text: "Fine." }, WEDNESDAY);
    await postResponse(db, eve, draft.id, { kind: "feedback", text: "Fine." }, WEDNESDAY);
    await expectError(startObjectionRound(db, ada, draft.id, WEDNESDAY), "invalid");
    expect(await startObjectionRound(db, ada, draft.id, at("2026-11-12"))).toBe("2026-11-17");
  });

  it("stays blocked until every consent giver gives a Go on the current version", async () => {
    const draft = await submitted(oneWay());
    await startObjectionRound(db, ada, draft.id, at("2026-11-12"));
    const afterPeriod = at("2026-11-18");

    await giveGo(db, amy, draft.id, { version: 1 }, at("2026-11-12"));
    expect((await state(draft.id, afterPeriod)).readiness.ready).toBe(false); // no answer is not a Go
    await giveGo(db, eve, draft.id, { version: 1 }, at("2026-11-12"));
    expect((await state(draft.id, afterPeriod)).readiness.ready).toBe(true);

    // A new version resets every Go.
    await addVersion(db, ada, draft.id, { proposalText: "Three months, then review.", changeNote: "Added a review.", personalDataConfirmed: "on" }, at("2026-11-13"));
    expect((await state(draft.id, afterPeriod)).readiness.ready).toBe(false);
    // A Go from a page that still showed version 1 is refused.
    await expectError(giveGo(db, amy, draft.id, { version: 1 }, at("2026-11-13")), "invalid", "version");
    await giveGo(db, amy, draft.id, { version: 2 }, at("2026-11-13"));
    await giveGo(db, eve, draft.id, { version: 2 }, at("2026-11-13"));

    // An objection from a consent giver blocks again; resolving it unblocks.
    const objection = await postResponse(db, eve, draft.id, { kind: "objection", text: "Payroll needs a month." }, at("2026-11-16"));
    expect((await state(draft.id, afterPeriod)).readiness.ready).toBe(false);
    await expectError(publishDecision(db, dan, draft.id, publish(), afterPeriod), "invalid");
    await expectError(resolveObjection(db, amy, draft.id, { responseId: objection!.id }, at("2026-11-16")), "forbidden");
    await resolveObjection(db, eve, draft.id, { responseId: objection!.id, note: "Start date moved." }, at("2026-11-16"));

    // Withdrawing a Go blocks; giving it again unblocks.
    await withdrawGo(db, amy, draft.id, at("2026-11-16"));
    expect((await state(draft.id, afterPeriod)).readiness.ready).toBe(false);
    await giveGo(db, amy, draft.id, { version: 2 }, at("2026-11-16"));

    await publishDecision(db, dan, draft.id, publish(), afterPeriod);
    expect((await state(draft.id)).entry.status).toBe("decided");
  });

  it("is blocked when a consent giver loses access, until an admin replaces them", async () => {
    const draft = await submitted(oneWay());
    await startObjectionRound(db, ada, draft.id, at("2026-11-12"));
    await giveGo(db, amy, draft.id, { version: 1 }, at("2026-11-12"));
    await giveGo(db, eve, draft.id, { version: 1 }, at("2026-11-12"));
    await db.update(person).set({ hasAccess: false }).where(eq(person.id, eve.personId));
    const after = at("2026-11-18");
    const blocked = await state(draft.id, after);
    expect(blocked.readiness.criteria.find((c) => c.key === "consent_access")?.ok).toBe(false);

    await expectError(replaceConsentGiver(db, ada, draft.id, { personId: eve.personId, replacementId: dan.personId, reason: "Left the organization" }, after), "forbidden");
    await replaceConsentGiver(db, amy, draft.id, { personId: eve.personId, replacementId: dan.personId, reason: "Eve left." }, after);
    await giveGo(db, dan, draft.id, { version: 1 }, after);
    expect((await state(draft.id, after)).readiness.ready).toBe(true);
  });
});

describe("type changes", () => {
  it("send a two-way proposal in the objection round back to feedback as one-way, with at least 5 working days", async () => {
    const draft = await submitted(draftInput());
    await postResponse(db, amy, draft.id, { kind: "feedback", text: "OK" }, WEDNESDAY);
    await startObjectionRound(db, ada, draft.id, WEDNESDAY);
    await expectError(
      changeReversibility(db, ada, draft.id, { to: "one_way", reason: "Contracts change.", reversibilityReason: "Contracts", consentGiverIds: [] }, WEDNESDAY),
      "invalid",
      "consentGiverIds",
    );
    await changeReversibility(
      db,
      ada,
      draft.id,
      { to: "one_way", reason: "Contracts change.", reversibilityReason: "Employment contracts change.", consentGiverIds: [amy.personId] },
      WEDNESDAY,
    );
    const changed = await state(draft.id);
    expect(changed.entry.status).toBe("feedback");
    expect(changed.decision).toMatchObject({ reversibility: "one_way", reversibilityReason: "Employment contracts change." });
    expect(changed.proposal).toMatchObject({ feedbackDeadline: "2026-11-11", objectionPeriodDays: 3, objectionDeadline: null });
  });

  it("do not count Gos given under two-way rules as one-way consent", async () => {
    const draft = await submitted(draftInput());
    await postResponse(db, amy, draft.id, { kind: "feedback", text: "OK" }, WEDNESDAY);
    await startObjectionRound(db, ada, draft.id, WEDNESDAY);
    await giveGo(db, amy, draft.id, { version: 1 }, WEDNESDAY);
    await changeReversibility(
      db,
      ada,
      draft.id,
      { to: "one_way", reason: "Contracts change.", reversibilityReason: "Contracts", consentGiverIds: [amy.personId] },
      at("2026-11-05"),
    );
    // Back in feedback until 2026-11-12 (5 working days from the change).
    await startObjectionRound(db, ada, draft.id, at("2026-11-13"));
    const after = at("2026-11-19");
    expect((await state(draft.id, after)).readiness.ready).toBe(false);
    await giveGo(db, amy, draft.id, { version: 1 }, at("2026-11-13"));
    expect((await state(draft.id, after)).readiness.ready).toBe(true);
  });

  it("turn consent givers into feedback givers when a one-way proposal becomes two-way, but only in the feedback phase", async () => {
    const draft = await submitted(oneWay());
    await changeReversibility(db, ada, draft.id, { to: "two_way", reason: "Easy to undo after all.", consentGiverIds: [] }, WEDNESDAY);
    const changed = await state(draft.id);
    expect(changed.snapshot.participants.map((p) => p.role).sort()).toEqual(["feedback_giver", "feedback_giver"]);

    const other = await submitted(oneWay());
    await startObjectionRound(db, ada, other.id, at("2026-11-12"));
    await expectError(changeReversibility(db, ada, other.id, { to: "two_way", reason: "x", consentGiverIds: [] }, at("2026-11-12")), "forbidden");
  });
});

describe("people", () => {
  it("follow the removal rules for consent givers", async () => {
    const draft = await submitted(oneWay());
    // Feedback phase: the proposer can remove one, but not the last.
    await removeParticipant(db, ada, draft.id, { personId: eve.personId, role: "consent_giver" }, WEDNESDAY);
    await expectError(removeParticipant(db, ada, draft.id, { personId: amy.personId, role: "consent_giver" }, WEDNESDAY), "invalid", "personId");
    await addParticipant(db, ada, draft.id, { personId: eve.personId, role: "consent_giver" }, WEDNESDAY);

    // Objection round: only the decider, with a reason; not while an objection is open, except an admin.
    await startObjectionRound(db, ada, draft.id, at("2026-11-12"));
    await postResponse(db, eve, draft.id, { kind: "objection", text: "No." }, at("2026-11-12"));
    await expectError(removeParticipant(db, ada, draft.id, { personId: amy.personId, role: "consent_giver" }, at("2026-11-12")), "forbidden");
    await expectError(removeParticipant(db, dan, draft.id, { personId: amy.personId, role: "consent_giver" }, at("2026-11-12")), "invalid", "reason");
    await expectError(
      removeParticipant(db, dan, draft.id, { personId: eve.personId, role: "consent_giver", reason: "Blocking" }, at("2026-11-12")),
      "invalid",
      "personId",
    );
    await removeParticipant(db, amy, draft.id, { personId: eve.personId, role: "consent_giver", reason: "Admin decision after a facilitated meeting." }, at("2026-11-12"));
    const removed = await db
      .select()
      .from(participant)
      .where(and(eq(participant.entryId, draft.id), eq(participant.personId, eve.personId)));
    expect(removed.every((row) => row.removedAt !== null)).toBe(true);
  });

  it("lets the proposer change the decider in feedback, afterwards only an admin with a reason", async () => {
    const draft = await submitted(draftInput({ feedbackGiverIds: [] }));
    await changeDecider(db, ada, draft.id, { deciderId: amy.personId }, WEDNESDAY);
    await startObjectionRound(db, ada, draft.id, at("2026-11-09"));
    await expectError(changeDecider(db, ada, draft.id, { deciderId: dan.personId }, at("2026-11-09")), "forbidden");
    await expectError(changeDecider(db, amy, draft.id, { deciderId: dan.personId }, at("2026-11-09")), "invalid", "reason");
    await changeDecider(db, amy, draft.id, { deciderId: dan.personId, reason: "Amy is on leave." }, at("2026-11-09"));
    expect((await state(draft.id)).decision.deciderId).toBe(dan.personId);
  });
});

describe("questions, deadlines, and versions", () => {
  it("lets the proposer answer each question once", async () => {
    const draft = await submitted(draftInput());
    const question = await postResponse(db, amy, draft.id, { kind: "question", text: "Which day off?" }, WEDNESDAY);
    await expectError(answerQuestion(db, amy, draft.id, { questionId: question!.id, text: "Friday" }, WEDNESDAY), "forbidden");
    await answerQuestion(db, ada, draft.id, { questionId: question!.id, text: "Friday." }, WEDNESDAY);
    await expectError(answerQuestion(db, ada, draft.id, { questionId: question!.id, text: "Monday." }, WEDNESDAY), "invalid");
  });

  it("extends deadlines but never shortens them", async () => {
    const draft = await submitted(draftInput());
    await expectError(extendDeadline(db, ada, draft.id, { phase: "feedback", deadline: "2026-11-05" }, WEDNESDAY), "invalid", "deadline");
    await extendDeadline(db, ada, draft.id, { phase: "feedback", deadline: "2026-11-10" }, WEDNESDAY);
    expect((await state(draft.id)).proposal.feedbackDeadline).toBe("2026-11-10");
    await expectError(extendDeadline(db, ada, draft.id, { phase: "objection", deadline: "2026-11-20" }, WEDNESDAY), "forbidden");
  });

  it("keeps every version and confirms personal data for each", async () => {
    const draft = await submitted(draftInput());
    await addVersion(db, ada, draft.id, { proposalText: "v2", personalDataConfirmed: "on" }, WEDNESDAY);
    await expectError(addVersion(db, amy, draft.id, { proposalText: "v3", personalDataConfirmed: "on" }, WEDNESDAY), "forbidden");
    const versions = await db.select().from(proposalVersion).where(eq(proposalVersion.entryId, draft.id)).orderBy(proposalVersion.number);
    expect(versions.map((v) => [v.number, v.text, v.personalDataConfirmedAt !== null])).toEqual([
      [1, "We try a four-day week for three months.", true],
      [2, "v2", true],
    ]);
  });
});

describe("superseding", () => {
  async function decidedOneWay() {
    // Submitted Monday 2026-11-02; 5 working days later is Monday 2026-11-09.
    const draft = await submitted(oneWay({ feedbackDeadline: "2026-11-09" }), MONDAY);
    await startObjectionRound(db, ada, draft.id, at("2026-11-10"));
    await giveGo(db, amy, draft.id, { version: 1 }, at("2026-11-10"));
    await giveGo(db, eve, draft.id, { version: 1 }, at("2026-11-10"));
    await publishDecision(db, dan, draft.id, publish(), at("2026-11-16"));
    return draft;
  }

  it("replaces a one-way decision only with a one-way proposal", async () => {
    const old = await decidedOneWay();
    await expectError(saveDraft(db, ada, draftInput({ supersedesId: old.id }), undefined, at("2026-11-16")), "invalid", "supersedesId");
    const record = decisionInputSchema.parse({
      type: "decision",
      impact: "medium",
      reversibility: "two_way",
      title: "Record",
      teamId: seed.teams.tech.id,
      summary: "s",
      decisionText: "d",
      rationale: "r",
      deciderId: dan.personId,
      howDecided: "other",
      decidedOn: "2026-11-16",
      supersedesId: old.id,
      personalDataConfirmed: "on",
    });
    await expectError(logDecision(db, ada, record, at("2026-11-16")), "invalid", "supersedesId");

    const replacement = await submitted(oneWay({ supersedesId: old.id, feedbackDeadline: "2026-11-23" }), at("2026-11-16"));
    // It cannot become two-way while it replaces a one-way decision.
    await expectError(
      changeReversibility(db, ada, replacement.id, { to: "two_way", reason: "Easier", consentGiverIds: [] }, at("2026-11-16")),
      "invalid",
      "supersedesId",
    );
    await startObjectionRound(db, ada, replacement.id, at("2026-11-24"));
    await giveGo(db, amy, replacement.id, { version: 1 }, at("2026-11-24"));
    await giveGo(db, eve, replacement.id, { version: 1 }, at("2026-11-24"));
    await publishDecision(db, dan, replacement.id, publish(), at("2026-11-30"));
    expect((await state(old.id)).entry).toMatchObject({ status: "decided", supersededById: replacement.id });
  });
});

describe("no deletion", () => {
  it("refuses to delete responses and participants of submitted proposals", async () => {
    const draft = await submitted(draftInput());
    await postResponse(db, amy, draft.id, { kind: "question", text: "?" }, WEDNESDAY);
    for (const attempt of [db.delete(response), db.delete(participant).where(eq(participant.entryId, draft.id))]) {
      const error = await attempt.then(
        () => undefined,
        (caught: unknown) => caught as { cause?: { code?: string } },
      );
      expect(error?.cause?.code).toBe("23001");
    }
    await expectError(discardDraft(db, ada, draft.id), "not_found");
  });
});

function publish(overrides: { objectionHandling?: string } = {}) {
  return publishSchema.parse({
    summary: "The tech team tries a four-day week for three months.",
    finalText: "We try a four-day week for three months.",
    rationale: "Focus time matters.",
    personalDataConfirmed: "on",
    ...overrides,
  });
}

describe("what each command records", () => {
  /**
   * Runs `act` and returns what it recorded: new audit events, new messages
   * as "event → recipient", and whether the webhook was requested.
   */
  async function recorded(entryId: string, act: () => Promise<unknown>) {
    const names = new Map([
      [ada.personId, "Ada"],
      [dan.personId, "Dan"],
      [amy.personId, "Amy"],
      [eve.personId, "Eve"],
    ]);
    const auditBefore = (await db.select().from(auditEvent)).length;
    const deliveriesBefore = new Set((await db.select().from(notificationDelivery)).map((d) => d.id));
    const webhookRequested = async () => (await db.select().from(webhookState).where(eq(webhookState.entryId, entryId)))[0]?.requestedAt ?? null;
    const requestedBefore = await webhookRequested();
    await act();
    const audit = (await db.select().from(auditEvent).orderBy(asc(auditEvent.id))).slice(auditBefore);
    const messages = (await db.select().from(notificationDelivery))
      .filter((d) => !deliveriesBefore.has(d.id))
      .map((d) => `${d.event} → ${d.recipientId ? names.get(d.recipientId) : "channel"}`)
      .sort();
    const requestedAfter = await webhookRequested();
    return { audit: audit.map((e) => e.action), messages, webhook: requestedAfter !== null && requestedAfter.getTime() !== requestedBefore?.getTime() };
  }

  /** A two-way proposal with Amy asked for feedback; ready once the objection round starts and Amy answers. */
  const twoWay = () => submitted(draftInput());
  async function inObjectionRound() {
    const draft = await twoWay();
    await postResponse(db, amy, draft.id, { kind: "feedback", text: "Fine." }, WEDNESDAY);
    await startObjectionRound(db, ada, draft.id, WEDNESDAY);
    return draft.id;
  }

  it("submitting tells the requested people, the decider, and the channel", async () => {
    const draft = await saveDraft(db, ada, draftInput(), undefined, WEDNESDAY);
    expect(await recorded(draft.id, () => submitProposal(db, ada, draft.id, WEDNESDAY))).toEqual({
      audit: ["proposal.submitted"],
      messages: ["channel.submitted → channel", "proposal.submitted → Amy", "proposal.submitted → Dan"],
      webhook: false,
    });
  });

  it("a question tells the proposer, and the answer tells the asker", async () => {
    const { id } = await twoWay();
    let question: { id: string } | undefined;
    expect(
      await recorded(id, async () => {
        question = await postResponse(db, amy, id, { kind: "question", text: "Fridays too?" }, WEDNESDAY);
      }),
    ).toEqual({ audit: ["proposal.question_asked"], messages: ["proposal.question → Ada"], webhook: false });
    expect(await recorded(id, () => answerQuestion(db, ada, id, { questionId: question!.id, text: "Yes." }, WEDNESDAY))).toEqual({
      audit: ["proposal.question_answered"],
      messages: ["proposal.answered → Amy"],
      webhook: false,
    });
  });

  it("feedback is recorded quietly; a new version tells those who gave feedback", async () => {
    const { id } = await twoWay();
    expect(await recorded(id, () => postResponse(db, amy, id, { kind: "feedback", text: "Fine." }, WEDNESDAY))).toEqual({
      audit: ["proposal.feedback_given"],
      messages: [],
      webhook: false,
    });
    expect(await recorded(id, () => addVersion(db, ada, id, { proposalText: "Four days, three months.", personalDataConfirmed: "on" }, WEDNESDAY))).toEqual({
      audit: ["proposal.version_added"],
      messages: ["proposal.version → Amy"],
      webhook: false,
    });
  });

  it("an extended deadline tells who has not answered yet", async () => {
    const { id } = await twoWay();
    expect(await recorded(id, () => extendDeadline(db, ada, id, { phase: "feedback", deadline: "2026-11-09" }, WEDNESDAY))).toEqual({
      audit: ["proposal.deadline_extended"],
      messages: ["proposal.deadline_extended → Amy"],
      webhook: false,
    });
  });

  it("the objection round tells the requested people and the decider", async () => {
    const { id } = await twoWay();
    await postResponse(db, amy, id, { kind: "feedback", text: "Fine." }, WEDNESDAY);
    expect(await recorded(id, () => startObjectionRound(db, ada, id, WEDNESDAY))).toEqual({
      audit: ["proposal.objection_round_started"],
      messages: ["proposal.objection_round → Amy", "proposal.objection_round → Dan"],
      webhook: false,
    });
  });

  it("the last answer tells the decider that the proposal is ready; withdrawing it tells nobody", async () => {
    const id = await inObjectionRound();
    expect(await recorded(id, () => giveGo(db, amy, id, { version: 1 }, WEDNESDAY))).toEqual({
      audit: ["proposal.go_given"],
      messages: ["proposal.ready → Dan"],
      webhook: false,
    });
    expect(await recorded(id, () => withdrawGo(db, amy, id, WEDNESDAY))).toEqual({ audit: ["proposal.go_withdrawn"], messages: [], webhook: false });
    const [row] = await db.select().from(proposal).where(eq(proposal.entryId, id));
    expect(row?.readySince).toBeNull();
  });

  it("an objection tells the proposer and the decider; resolving it tells nobody", async () => {
    const id = await inObjectionRound();
    let objection: { id: string } | undefined;
    expect(
      await recorded(id, async () => {
        objection = await postResponse(db, amy, id, { kind: "objection", text: "Customers need us on Fridays." }, WEDNESDAY);
      }),
    ).toEqual({
      audit: ["proposal.objection_raised"],
      // Amy's objection is her answer, so the two-way proposal is ready.
      messages: ["proposal.objection → Ada", "proposal.objection → Dan", "proposal.ready → Dan"],
      webhook: false,
    });
    expect(await recorded(id, () => resolveObjection(db, amy, id, { responseId: objection!.id }, WEDNESDAY))).toEqual({
      audit: ["proposal.objection_resolved"],
      messages: [],
      webhook: false,
    });
  });

  it("a new decider of a ready proposal hears both", async () => {
    const id = await inObjectionRound();
    await giveGo(db, amy, id, { version: 1 }, WEDNESDAY);
    expect(await recorded(id, () => changeDecider(db, amy, id, { deciderId: eve.personId, reason: "Dan is away." }, WEDNESDAY))).toEqual({
      audit: ["proposal.decider_changed"],
      messages: ["proposal.decider_changed → Eve", "proposal.ready → Eve"],
      webhook: false,
    });
  });

  it("adding a person tells them; removing one tells nobody", async () => {
    const { id } = await twoWay();
    expect(await recorded(id, () => addParticipant(db, ada, id, { personId: eve.personId, role: "feedback_giver" }, WEDNESDAY))).toEqual({
      audit: ["proposal.participant_added"],
      messages: ["proposal.participant_added → Eve"],
      webhook: false,
    });
    expect(await recorded(id, () => removeParticipant(db, ada, id, { personId: amy.personId, role: "feedback_giver" }, WEDNESDAY))).toEqual({
      audit: ["proposal.participant_removed"],
      messages: [],
      webhook: false,
    });
  });

  it("replacing a consent giver records both changes and tells the new one", async () => {
    const { id } = await submitted(oneWay());
    expect(
      await recorded(id, () => replaceConsentGiver(db, amy, id, { personId: eve.personId, replacementId: seed.people.dan.id, reason: "Eve left." }, WEDNESDAY)),
    ).toEqual({
      audit: ["proposal.participant_removed", "proposal.participant_added"],
      messages: ["proposal.participant_added → Dan"],
      webhook: false,
    });
  });

  it("a change to one-way tells everyone on the proposal", async () => {
    const { id } = await twoWay();
    const input = { to: "one_way" as const, reason: "Contracts change.", reversibilityReason: "Contracts change.", consentGiverIds: [eve.personId] };
    expect(await recorded(id, () => changeReversibility(db, ada, id, input, WEDNESDAY))).toEqual({
      audit: ["proposal.type_changed"],
      messages: ["proposal.one_way → Amy", "proposal.one_way → Dan", "proposal.one_way → Eve"],
      webhook: false,
    });
  });

  it("publishing and rejecting reach the webhook and the channel; withdrawing reaches neither", async () => {
    const published = await inObjectionRound();
    await giveGo(db, amy, published, { version: 1 }, WEDNESDAY);
    expect(await recorded(published, () => publishDecision(db, dan, published, publish(), WEDNESDAY))).toEqual({
      audit: ["proposal.decided"],
      messages: ["channel.decided → channel", "proposal.closed → Ada", "proposal.closed → Amy"],
      webhook: true,
    });

    const rejected = await inObjectionRound();
    expect(await recorded(rejected, () => rejectProposal(db, dan, rejected, { rationale: "Not now." }, WEDNESDAY))).toEqual({
      audit: ["proposal.rejected"],
      messages: ["channel.rejected → channel", "proposal.closed → Ada", "proposal.closed → Amy"],
      webhook: true,
    });

    const { id: withdrawn } = await twoWay();
    expect(await recorded(withdrawn, () => withdrawProposal(db, ada, withdrawn, {}, WEDNESDAY))).toEqual({
      audit: ["proposal.withdrawn"],
      messages: ["proposal.closed → Amy", "proposal.closed → Dan"],
      webhook: false,
    });
  });
});

describe("the proposal page's pickers", () => {
  it("offer only the people the rules allow", async () => {
    const { id } = await submitted(oneWay()); // Amy and Eve give consent, Dan decides
    const candidates = [ada, dan, amy, eve].map((a) => a.personId);
    const names = new Map([
      [ada.personId, "Ada"],
      [dan.personId, "Dan"],
      [amy.personId, "Amy"],
      [eve.personId, "Eve"],
    ]);
    const named = (ids: string[]) => ids.map((personId) => names.get(personId));

    const byProposer = (await getProposalView(db, id, ada, candidates, WEDNESDAY))!;
    expect(named(byProposer.choices.consentGivers)).toEqual(["Dan"]);
    expect(named(byProposer.choices.feedbackGivers)).toEqual(["Ada", "Dan", "Amy", "Eve"]);
    expect(named(byProposer.choices.deciders)).toEqual(["Ada", "Amy", "Eve"]);
    expect(byProposer.participants.every((p) => p.replacements.length === 0)).toBe(true); // only admins replace

    const byAdmin = (await getProposalView(db, id, amy, candidates, WEDNESDAY))!;
    expect(new Map(byAdmin.participants.map((p) => [names.get(p.personId), named(p.replacements)]))).toEqual(
      new Map([
        ["Amy", ["Dan"]],
        ["Eve", ["Dan"]],
      ]),
    );
    expect(byAdmin.choices.consentGivers).toEqual([]); // the proposer manages participants
  });
});
