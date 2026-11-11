import { describe, expect, it } from "vitest";
import type { ProposalSnapshot, SnapshotResponse } from "@/lib/process/rules";
import {
  planAddendum,
  planEntryPost,
  planLostAccess,
  planProposalEvent,
  planReminders,
  planReviewReminder,
  type PlannedDelivery,
  type PostInfo,
  type ProposalEvent,
} from "./plan";

const ENTRY = { id: "e1", number: 12, title: "Switch to Linear" };
const POST: PostInfo = { type: "decision", summary: "Linear for every team.", impact: "medium", affectedTeams: ["Ops"] };
const PROPOSER = "proposer";
const DECIDER = "decider";
const ANA = "ana";
const BEN = "ben";
const CARL = "carl";

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
    status: "feedback",
    reversibility: "two_way",
    proposerId: PROPOSER,
    deciderId: DECIDER,
    deciderHasAccess: true,
    submittedOn: "2026-11-02",
    feedbackDeadline: "2026-11-06",
    objectionPeriodDays: 1,
    objectionRoundStartedAt: null,
    objectionDeadline: null,
    currentVersion: 1,
    goResetAt: null,
    participants: [
      { personId: ANA, role: "feedback_giver", hasAccess: true },
      { personId: BEN, role: "feedback_giver", hasAccess: true },
    ],
    responses: [],
    ...overrides,
  };
}

const oneWay = (overrides: Partial<ProposalSnapshot> = {}) =>
  snapshot({
    reversibility: "one_way",
    participants: [
      { personId: ANA, role: "consent_giver", hasAccess: true },
      { personId: BEN, role: "feedback_giver", hasAccess: true },
    ],
    ...overrides,
  });

const plan = (s: ProposalSnapshot, event: ProposalEvent, actor = PROPOSER) =>
  planProposalEvent({ entry: ENTRY, s, actor: { personId: actor, name: "Pia Proposer" }, post: POST }, event);

/** Direct recipients; posts to the Logbuch channel are checked separately. */
const recipients = (planned: PlannedDelivery[]) => planned.filter((p) => p.channel !== "slack_channel").map((p) => p.recipientId);
const channelPosts = (planned: PlannedDelivery[]) => planned.filter((p) => p.channel === "slack_channel");
const byRecipient = (planned: PlannedDelivery[]) => new Map(planned.map((p) => [p.recipientId, p]));

describe("event notifications", () => {
  it("tell feedback givers, consent givers, and the decider about a submitted proposal, on Slack", () => {
    const planned = plan(oneWay(), { type: "submitted" });
    expect(recipients(planned)).toEqual([ANA, BEN, DECIDER]);
    expect(planned.every((p) => p.channel === "slack" || p.channel === "slack_channel")).toBe(true);
    const ana = byRecipient(planned).get(ANA)!;
    expect(ana.key).toBe(`proposal.submitted:e1:${ANA}`);
    expect(ana.message).toMatchObject({
      subject: "Consent requested: LB-12 Switch to Linear",
      ref: "LB-12",
      path: "/e/LB-12",
      deadline: { label: "Feedback deadline", date: "2026-11-06" },
    });
    expect(byRecipient(planned).get(BEN)!.message.subject).toBe("Feedback requested: LB-12 Switch to Linear");
    expect(byRecipient(planned).get(DECIDER)!.message.subject).toBe("You are the decider: LB-12 Switch to Linear");
  });

  it("send one message per person, the most specific one, and none to the actor", () => {
    const s = snapshot({
      deciderId: ANA,
      participants: [
        { personId: ANA, role: "feedback_giver", hasAccess: true },
        { personId: PROPOSER, role: "feedback_giver", hasAccess: true },
      ],
    });
    const planned = plan(s, { type: "submitted" });
    expect(recipients(planned)).toEqual([ANA]);
    expect(planned[0]!.message.subject).toMatch(/^Feedback requested/);
  });

  it("tell the proposer about a question, and the proposer and decider about an objection", () => {
    expect(recipients(plan(snapshot(), { type: "question", responseId: "q1" }, ANA))).toEqual([PROPOSER]);
    const objection = response(ANA, "objection");
    const s = oneWay({ status: "objection_round", objectionDeadline: "2026-11-10", responses: [objection] });
    const planned = plan(s, { type: "objection", responseId: objection.id }, ANA);
    expect(recipients(planned)).toEqual([PROPOSER, DECIDER]);
    expect(planned[0]!.message.text).toBe("Pia Proposer raised an objection. It blocks the decision until it is resolved.");
    expect(planned[0]!.key).toBe(`proposal.objection:${objection.id}:${PROPOSER}`);
  });

  it("ask consent givers with a Go to confirm a new version, and tell everyone who gave feedback", () => {
    const s = oneWay({
      status: "objection_round",
      objectionDeadline: "2026-11-10",
      currentVersion: 2,
      participants: [
        { personId: ANA, role: "consent_giver", hasAccess: true },
        { personId: BEN, role: "consent_giver", hasAccess: true },
      ],
      responses: [response(ANA, "go"), response(CARL, "feedback")],
    });
    const planned = plan(s, { type: "version", version: 2 });
    expect(recipients(planned)).toEqual([ANA, CARL]);
    expect(byRecipient(planned).get(ANA)!.message).toMatchObject({
      subject: "Please confirm again: LB-12 Switch to Linear",
      deadline: { label: "Objection deadline", date: "2026-11-10" },
    });
    expect(planned.map((p) => p.key)).toEqual([`proposal.version:e1:v2:${ANA}`, `proposal.version:e1:v2:${CARL}`]);
  });

  it("do not ask for a new Go when the earlier Go was given before the switch to one-way", () => {
    const s = oneWay({ currentVersion: 2, goResetAt: new Date(Date.UTC(2026, 10, 4)), responses: [response(ANA, "go")] });
    expect(recipients(plan(s, { type: "version", version: 2 }))).toEqual([]);
  });

  it("tell requested people and the decider that the objection round started, with what to do", () => {
    const s = oneWay({ status: "objection_round", objectionDeadline: "2026-11-11" });
    const planned = byRecipient(plan(s, { type: "objection_round" }));
    expect([...planned.keys()]).toEqual([ANA, BEN, DECIDER]);
    expect(planned.get(ANA)!.message.text).toBe("The objection round has started. Give your Go on version 1, or raise an objection.");
    expect(planned.get(BEN)!.message.text).toBe("The objection round has started. You can raise an objection.");
    expect(planned.get(ANA)!.key).toBe(`proposal.objection_round:e1:2026-11-11:${ANA}`);
  });

  it("tell only people who have not answered about an extended deadline", () => {
    const s = snapshot({ feedbackDeadline: "2026-11-09", responses: [response(ANA, "feedback")] });
    const planned = plan(s, { type: "deadline_extended", phase: "feedback", deadline: "2026-11-09" });
    expect(recipients(planned)).toEqual([BEN]);
    expect(planned[0]!.message.deadline).toEqual({ label: "Feedback deadline", date: "2026-11-09" });
  });

  it("tell everyone listed when a proposal becomes one-way", () => {
    const at = new Date("2026-11-04T10:00:00Z");
    const planned = plan(oneWay(), { type: "one_way", at, backToFeedback: true });
    expect(recipients(planned)).toEqual([ANA, BEN, DECIDER]);
    expect(byRecipient(planned).get(ANA)!.message.text).toContain("You are a consent giver.");
    expect(byRecipient(planned).get(BEN)!.message.text).toBe("Pia Proposer changed this proposal to a one-way decision. It is back in the feedback phase.");
    expect(planned[0]!.key).toBe(`proposal.one_way:e1:${at.toISOString()}:${ANA}`);
  });

  it("tell a person who was added, and a new decider", () => {
    const at = new Date("2026-11-04T10:00:00Z");
    expect(recipients(plan(snapshot(), { type: "participant_added", personId: CARL, role: "feedback_giver", at }))).toEqual([CARL]);
    expect(recipients(plan(snapshot(), { type: "decider_changed", at }))).toEqual([DECIDER]);
  });

  it("tell the decider when ready, with a link to the decide view, once per time it becomes ready", () => {
    const s = snapshot({ status: "objection_round", objectionDeadline: "2026-11-05", currentVersion: 3 });
    const since = new Date("2026-11-04T10:00:00Z");
    const planned = plan(s, { type: "ready", since }, ANA);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ recipientId: DECIDER, key: `proposal.ready:e1:${since.toISOString()}:${DECIDER}` });
    expect(planned[0]!.message.path).toBe("/e/LB-12/decide");
  });

  it("do not tell the decider when their own action made the proposal ready", () => {
    const s = snapshot({ status: "objection_round", objectionDeadline: "2026-11-05" });
    expect(plan(s, { type: "ready", since: new Date() }, DECIDER)).toEqual([]);
  });

  it("tell everyone listed and everyone who commented about the outcome, except the actor", () => {
    const s = snapshot({ status: "decided", responses: [response(CARL, "question"), response(ANA, "feedback")] });
    const planned = plan(s, { type: "closed", result: "decided" }, DECIDER);
    expect(recipients(planned)).toEqual([PROPOSER, ANA, BEN, CARL]);
    expect(planned[0]!.message.text).toBe("Pia Proposer published the decision.");
  });

  it("tell the asker that their question was answered", () => {
    const question = response(CARL, "question");
    const s = snapshot({ responses: [question, response(PROPOSER, "answer", { parentId: question.id })] });
    const planned = plan(s, { type: "answered", questionId: question.id });
    expect(planned.map((p) => [p.recipientId, p.key, p.message.subject])).toEqual([
      [CARL, `proposal.answered:${question.id}:${CARL}`, "Question answered: LB-12 Switch to Linear"],
    ]);
    expect(planned[0]!.message.text).toBe("Pia Proposer answered your question.");
    expect(plan(s, { type: "answered", questionId: "unknown" })).toEqual([]);
  });

  it("tell the proposer once per person who lost access, naming every role they hold", () => {
    const since = new Date("2026-11-04T08:00:00Z");
    const row = { entry: ENTRY, proposerId: PROPOSER, personId: ANA, name: "Ana", since };
    const other = { id: "e2", number: 13, title: "Other" };
    const planned = planLostAccess([
      { ...row, role: "feedback_giver" },
      { ...row, role: "decider" },
      { ...row, role: "feedback_giver" },
      { ...row, entry: other, personId: BEN, name: "Ben", role: "consent_giver" },
    ]);
    expect(planned.map((p) => [p.recipientId, p.key])).toEqual([
      [PROPOSER, `proposal.lost_access:e1:${ANA}:${since.toISOString()}:${PROPOSER}`],
      [PROPOSER, `proposal.lost_access:e2:${BEN}:${since.toISOString()}:${PROPOSER}`],
    ]);
    expect(planned[0]!.message.text).toBe(
      "Ana no longer has access to Logbuch and is the decider and a feedback giver on this proposal. Replace them so the decision can go ahead.",
    );
  });

  it("tell the author, the decider, and everyone listed about an addendum, except whoever added it", () => {
    const planned = planAddendum(ENTRY, "a1", { personId: DECIDER, name: "Dan" }, { authorId: PROPOSER, deciderId: DECIDER, listedIds: [ANA, ANA] });
    expect(recipients(planned)).toEqual([PROPOSER, ANA]);
    expect(planned[0]!.key).toBe(`entry.addendum:a1:${PROPOSER}`);
    expect(recipients(planAddendum(ENTRY, "a2", { personId: ANA, name: "Ana" }, { authorId: PROPOSER, deciderId: null, listedIds: [] }))).toEqual([PROPOSER]);
  });
});

describe("reminders", () => {
  // Thursday 2026-11-05, 09:00 in Amsterdam.
  const NOW = new Date("2026-11-05T08:00:00Z");
  const READY_SINCE = new Date("2026-11-03T10:00:00Z"); // Tuesday
  const remind = (s: ProposalSnapshot, today: string, readySince?: Date) => planReminders({ entry: ENTRY, s, today, now: NOW, readySince });

  const cases: [string, ProposalSnapshot, string, string[]][] = [
    ["feedback due on Friday: reminded on Thursday", snapshot({ feedbackDeadline: "2026-11-06" }), "2026-11-05", [`reminder.deadline:e1:feedback:2026-11-06:${ANA}`, `reminder.deadline:e1:feedback:2026-11-06:${BEN}`]],
    ["not two working days before", snapshot({ feedbackDeadline: "2026-11-06" }), "2026-11-04", []],
    ["feedback due on Monday: reminded on Friday", snapshot({ feedbackDeadline: "2026-11-09" }), "2026-11-06", [`reminder.deadline:e1:feedback:2026-11-09:${ANA}`, `reminder.deadline:e1:feedback:2026-11-09:${BEN}`]],
    ["only people who have not answered", snapshot({ feedbackDeadline: "2026-11-06", responses: [response(ANA, "feedback")] }), "2026-11-05", [`reminder.deadline:e1:feedback:2026-11-06:${BEN}`]],
    [
      "one-way objection round: consent givers without a Go, not feedback givers",
      oneWay({ status: "objection_round", objectionDeadline: "2026-11-06" }),
      "2026-11-05",
      [`reminder.deadline:e1:objection:2026-11-06:${ANA}`],
    ],
    ["start the objection round: 1 working day after the deadline", snapshot({ feedbackDeadline: "2026-11-04" }), "2026-11-05", [`reminder.start_round:e1:2026-11-04:1:${PROPOSER}`]],
    ["start the objection round: then every 2 working days", snapshot({ feedbackDeadline: "2026-11-04" }), "2026-11-09", [`reminder.start_round:e1:2026-11-04:2:${PROPOSER}`]],
    ["start the objection round: not in between", snapshot({ feedbackDeadline: "2026-11-04" }), "2026-11-06", []],
    ["start the objection round: at most 3 times", snapshot({ feedbackDeadline: "2026-11-04" }), "2026-11-13", []],
    [
      "one-way blocked after the deadline: proposer and decider, daily",
      oneWay({ status: "objection_round", objectionDeadline: "2026-11-02" }),
      "2026-11-05",
      [`reminder.blocked:e1:2026-11-02:3:${PROPOSER}`, `reminder.blocked:e1:2026-11-02:3:${DECIDER}`],
    ],
    ["one-way blocked: at most 5 times", oneWay({ status: "objection_round", objectionDeadline: "2026-10-26" }), "2026-11-05", []],
    [
      "ready but not published: 2 working days after it became ready",
      snapshot({ status: "objection_round", objectionDeadline: "2026-11-02" }),
      "2026-11-05",
      [`reminder.ready:e1:${READY_SINCE.toISOString()}:1:${DECIDER}`],
    ],
  ];
  it.each(cases)("%s", (_name, s, today, keys) => {
    const readySince = s.status === "objection_round" && s.reversibility === "two_way" ? READY_SINCE : undefined;
    const planned = remind(s, today, readySince);
    expect(planned.map((p) => p.key)).toEqual(keys);
    expect(planned.every((p) => p.channel === "email")).toBe(true);
  });

  it("explain why a one-way decision is blocked", () => {
    const [first] = remind(oneWay({ status: "objection_round", objectionDeadline: "2026-11-04" }), "2026-11-05");
    expect(first!.message.text).toBe(
      "The objection period ended on [[date:2026-11-04]], but the decision is blocked. Still open: Every consent giver gave a Go on version 1 (0 of 1).",
    );
  });

  it("send no ready reminder without a time the proposal became ready", () => {
    expect(remind(snapshot({ status: "objection_round", objectionDeadline: "2026-11-02" }), "2026-11-05")).toEqual([]);
  });
});

describe("review-date reminders", () => {
  const decision = { entry: ENTRY, status: "decided", supersededById: null, deciderId: DECIDER, authorId: PROPOSER };
  const remind = (reviewDate: string, today: string) => planReviewReminder({ ...decision, reviewDate, today });

  it("ask the decider and the author by email on the review date", () => {
    const planned = remind("2026-11-05", "2026-11-05");
    expect(planned.map((p) => [p.recipientId, p.channel, p.key])).toEqual([
      [DECIDER, "email", `reminder.review:e1:2026-11-05:${DECIDER}`],
      [PROPOSER, "email", `reminder.review:e1:2026-11-05:${PROPOSER}`],
    ]);
    expect(planned[0]!.message.text).toContain("[[date:2026-11-05]]");
  });

  it("move a review date on a weekend to the next working day, and send nothing before it", () => {
    expect(remind("2026-11-07", "2026-11-07")).toEqual([]);
    expect(remind("2026-11-09", "2026-11-06")).toEqual([]);
    expect(remind("2026-11-07", "2026-11-09")).toHaveLength(2);
  });

  it("still remind on a later working day when the reminder was not sent yet (the key keeps it to one)", () => {
    expect(remind("2026-11-05", "2026-11-06").map((p) => p.key)).toEqual([
      `reminder.review:e1:2026-11-05:${DECIDER}`,
      `reminder.review:e1:2026-11-05:${PROPOSER}`,
    ]);
  });

  it("send one reminder when the decider is the author", () => {
    expect(planReviewReminder({ ...decision, authorId: DECIDER, reviewDate: "2026-11-05", today: "2026-11-05" })).toHaveLength(1);
  });

  it("only for decisions in force: logged or decided, and not replaced", () => {
    const at = { reviewDate: "2026-11-05", today: "2026-11-05" };
    expect(planReviewReminder({ ...decision, ...at, status: "published" })).toHaveLength(2);
    expect(planReviewReminder({ ...decision, ...at, supersededById: "e9" })).toEqual([]);
    for (const status of ["draft", "feedback", "objection_round", "rejected", "withdrawn"]) {
      expect(planReviewReminder({ ...decision, ...at, status })).toEqual([]);
    }
  });
});

describe("the Logbuch Slack channel", () => {
  it("announces a submitted proposal once, with its feedback deadline", () => {
    const [post, ...rest] = channelPosts(plan(oneWay(), { type: "submitted" }));
    expect(rest).toEqual([]);
    expect(post).toMatchObject({
      key: "channel.submitted:e1",
      recipientId: null,
      entryId: "e1",
      message: { subject: "New proposal: LB-12 Switch to Linear", deadline: { label: "Feedback deadline", date: "2026-11-06" } },
    });
    expect(post!.message.text).toBe("Pia Proposer proposes a one-way decision. Feedback is open.");
  });

  it("announces decisions and rejections, not withdrawals", () => {
    const decided = snapshot({ status: "decided" });
    expect(channelPosts(plan(decided, { type: "closed", result: "decided" }, DECIDER)).map((p) => p.key)).toEqual(["channel.decided:e1"]);
    expect(channelPosts(plan(decided, { type: "closed", result: "rejected" }, DECIDER)).map((p) => p.key)).toEqual(["channel.rejected:e1"]);
    expect(channelPosts(plan(decided, { type: "closed", result: "withdrawn" }))).toEqual([]);
    expect(channelPosts(plan(snapshot(), { type: "question", responseId: "q" }, ANA))).toEqual([]);
  });

  it("show the summary, impact, and affected teams in every post", () => {
    const [post] = channelPosts(plan(oneWay(), { type: "submitted" }));
    expect(post!.message.post).toEqual({ type: "Decision", summary: "Linear for every team.", impact: "Medium", mustRead: false, affectedTeams: ["Ops"] });
  });

  it("announces updates, learnings, and logged decisions", () => {
    const post = (type: PostInfo["type"], impact: PostInfo["impact"] = "small") => planEntryPost(ENTRY, { ...POST, type, impact }, "Ada");
    expect(post("update")).toMatchObject({ key: "channel.update:e1", message: { text: "Ada posted an update.", post: { type: "Update", impact: "Small" } } });
    expect(post("learning")).toMatchObject({ key: "channel.learning:e1", message: { subject: "New learning: LB-12 Switch to Linear" } });
    expect(post("decision", "large")).toMatchObject({
      key: "channel.decision:e1",
      message: { subject: "Decision logged: LB-12 Switch to Linear", post: { impact: "Large", mustRead: true } },
    });
    expect(post("decision", null).message.post).toMatchObject({ impact: "Not set", mustRead: false });
  });
});
