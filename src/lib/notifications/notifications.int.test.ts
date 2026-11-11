import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { entry, notificationDelivery, person, proposal } from "@/lib/db/schema";
import { addAddendum, logDecision, createNote } from "@/lib/entries/commands";
import { decisionInputSchema, noteInputSchema } from "@/lib/entries/schemas";
import {
  extendDeadline,
  giveGo,
  withdrawGo,
  postResponse,
  publishDecision,
  refreshReadiness,
  saveDraft,
  startObjectionRound,
  submitProposal,
  withdrawProposal,
} from "@/lib/process/commands";
import type { Actor } from "@/lib/process/rules";
import { proposalDraftSchema, publishSchema, type ProposalDraftInput } from "@/lib/process/schemas";
import { dispatchDue, MAX_ATTEMPTS, retrySlackLookups } from "./dispatch";
import { notifyLostAccess, recordReminders } from "./notify";
import { getNotificationStatus } from "./queries";
import { DeliveryError, type Email, type SlackTransport, type Transports } from "./transports";

const testDb = connectTestDatabase();

/** The worker's proposal watcher. */
async function watchProposals(db: Parameters<typeof refreshReadiness>[0], now: Date) {
  await refreshReadiness(db, now);
  await notifyLostAccess(db, now);
}
const { db } = testDb;
let seed: Awaited<ReturnType<typeof seedDirectory>>;
let ada: Actor; // proposer
let dan: Actor; // decider
let amy: Actor;
let eve: Actor;

// Wednesday 2026-11-04, 10:00 in Amsterdam.
const WEDNESDAY = new Date("2026-11-04T09:00:00Z");
const at = (iso: string) => new Date(iso);

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
  for (const [actor, email] of [[ada, "ada"], [dan, "dan"], [amy, "amy"], [eve, "eve"]] as const) {
    await db.update(person).set({ workEmail: `${email}@example.org` }).where(eq(person.id, actor.personId));
  }
});
afterAll(() => testDb.close());

function draftInput(overrides: Partial<Record<keyof ProposalDraftInput, unknown>> = {}): ProposalDraftInput {
  return proposalDraftSchema.parse({
    title: "Four-day week",
    question: "Should the tech team try a four-day week?",
    body: "Focus time is scarce.",
    impact: "medium",
    proposalText: "We try a four-day week for three months.",
    reversibility: "two_way",
    deciderId: seed.people.dan.id,
    feedbackGiverIds: [amy.personId, eve.personId],
    teamId: seed.teams.tech.id,
    objectionPeriodDays: "1",
    feedbackDeadline: "2026-11-06",
    ...overrides,
  });
}

async function submitted(input = draftInput(), now = WEDNESDAY) {
  const draft = await saveDraft(db, ada, input, undefined, now);
  await submitProposal(db, ada, draft.id, now);
  return draft.id;
}

async function deliveries(event?: string) {
  const rows = await db.select().from(notificationDelivery).orderBy(asc(notificationDelivery.createdAt), asc(notificationDelivery.deliveryKey));
  return event ? rows.filter((r) => r.event === event) : rows;
}

const ids = (rows: { recipientId: string | null }[]) => rows.map((r) => r.recipientId ?? "channel").sort();
const sorted = (...actors: Actor[]) => actors.map((a) => a.personId).sort();

/** A proposal in the objection round that becomes ready once Amy answers. */
async function inObjectionRound() {
  const id = await submitted(draftInput({ feedbackGiverIds: [amy.personId] }));
  await postResponse(db, amy, id, { kind: "feedback", text: "Fine." }, WEDNESDAY);
  await startObjectionRound(db, ada, id, WEDNESDAY); // objection deadline: Thursday 2026-11-05
  return id;
}

describe("recording notifications", () => {
  it("tells requested people and the decider about a submitted proposal, never the actor or people without access", async () => {
    const id = await submitted();
    const submittedRows = await deliveries("proposal.submitted");
    expect(ids(submittedRows)).toEqual(sorted(dan, amy, eve));
    expect(submittedRows.every((r) => r.channel === "slack" && r.status === "pending")).toBe(true);
    expect(submittedRows[0]!.message.text).not.toContain("four-day week for three months");

    await db.update(person).set({ hasAccess: false }).where(eq(person.id, amy.personId));
    await withdrawProposal(db, ada, id, {}, WEDNESDAY);
    expect(ids(await deliveries("proposal.closed"))).toEqual(sorted(dan, eve));
  });

  it("tells the decider once when the last answer makes a proposal ready", async () => {
    const id = await inObjectionRound();
    expect(await deliveries("proposal.ready")).toHaveLength(0);
    await giveGo(db, amy, id, { version: 1 }, WEDNESDAY);
    const ready = await deliveries("proposal.ready");
    expect(ids(ready)).toEqual([dan.personId]);
    expect(ready[0]!.message.path).toMatch(/^\/e\/LB-\d+\/decide$/);

    await watchProposals(db, at("2026-11-06T09:00:00Z"));
    expect(await deliveries("proposal.ready")).toHaveLength(1);
  });

  it("tells the decider when the objection deadline passes, through the watcher", async () => {
    await inObjectionRound();
    await watchProposals(db, at("2026-11-05T20:00:00Z")); // Thursday 21:00 in Amsterdam: deadline not over
    expect(await deliveries("proposal.ready")).toHaveLength(0);
    await watchProposals(db, at("2026-11-05T23:00:00Z")); // Friday 00:00 in Amsterdam
    await watchProposals(db, at("2026-11-05T23:05:00Z"));
    expect(ids(await deliveries("proposal.ready"))).toEqual([dan.personId]);
  });

  it("tells the proposer once when someone listed lost access", async () => {
    await submitted();
    await db.update(person).set({ hasAccess: false, accessChangedAt: at("2026-11-04T12:00:00Z") }).where(eq(person.id, amy.personId));
    await watchProposals(db, WEDNESDAY);
    await watchProposals(db, WEDNESDAY);
    const lost = await deliveries("proposal.lost_access");
    expect(ids(lost)).toEqual([ada.personId]);
    expect(lost[0]!.message.text).toContain("Amy Admin no longer has access to Logbuch and is a feedback giver");
  });

  it("tells the people on a decision about an addendum", async () => {
    const id = await inObjectionRound();
    await giveGo(db, amy, id, { version: 1 }, WEDNESDAY);
    const publish = publishSchema.parse({ summary: "We do it.", finalText: "Yes.", rationale: "Focus.", personalDataConfirmed: "on" });
    await publishDecision(db, dan, id, publish, WEDNESDAY);
    expect(ids(await deliveries("proposal.closed"))).toEqual(sorted(ada, amy));
    await addAddendum(db, dan, id, { text: "Started on Monday.", personalDataConfirmed: "on" }, WEDNESDAY);
    expect(ids(await deliveries("entry.addendum"))).toEqual(sorted(ada, amy));
  });

  it("tells the decider of a logged decision about an addendum, even when not listed as involved", async () => {
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
      involvedIds: [eve.personId],
      howDecided: "other",
      decidedOn: "2026-11-03",
      personalDataConfirmed: "on",
    });
    const created = await logDecision(db, amy, record, WEDNESDAY);
    await addAddendum(db, amy, created!.id, { text: "Later.", personalDataConfirmed: "on" }, WEDNESDAY);
    expect(ids(await deliveries("entry.addendum"))).toEqual(sorted(dan, eve));
  });

  it("tells the decider again when a proposal becomes ready again", async () => {
    const id = await inObjectionRound();
    await giveGo(db, amy, id, { version: 1 }, WEDNESDAY);
    await withdrawGo(db, amy, id, at("2026-11-04T10:00:00Z"));
    expect((await db.select().from(proposal))[0]!.readySince).toBeNull();
    await giveGo(db, amy, id, { version: 1 }, at("2026-11-04T11:00:00Z"));
    expect((await db.select().from(proposal))[0]!.readySince).toEqual(at("2026-11-04T11:00:00Z"));
    expect(await deliveries("proposal.ready")).toHaveLength(2);
  });

  it("does not tell the decider about readiness their own answer caused, not even later", async () => {
    const id = await submitted(draftInput({ feedbackGiverIds: [dan.personId] }));
    await postResponse(db, dan, id, { kind: "feedback", text: "Fine." }, WEDNESDAY);
    await startObjectionRound(db, ada, id, WEDNESDAY);
    await giveGo(db, dan, id, { version: 1 }, WEDNESDAY);
    await watchProposals(db, at("2026-11-06T09:00:00Z"));
    expect(await deliveries("proposal.ready")).toHaveLength(0);
    // The reminder clock still runs: 2 working days later, an email.
    expect(await recordReminders(db, at("2026-11-06T09:00:00Z"))).toBe(1);
  });

  it("never deletes a delivery", async () => {
    await submitted();
    await expect(db.delete(notificationDelivery)).rejects.toThrow();
  });
});

describe("reminders", () => {
  it("are recorded at 09:00 on working days, once", async () => {
    const id = await submitted(); // feedback due Friday 2026-11-06
    await postResponse(db, eve, id, { kind: "feedback", text: "Fine." }, WEDNESDAY);
    expect(await recordReminders(db, at("2026-11-05T07:59:00Z"))).toBe(0); // Thursday 08:59 in Amsterdam
    expect(await recordReminders(db, at("2026-11-05T08:00:00Z"))).toBe(1);
    expect(await recordReminders(db, at("2026-11-05T08:30:00Z"))).toBe(0);
    const [reminder] = await deliveries("reminder.deadline");
    expect(reminder).toMatchObject({ recipientId: amy.personId, channel: "email" });
  });

  it("are not sent on weekends", async () => {
    await submitted(draftInput({ feedbackDeadline: "2026-11-09" })); // Monday; the reminder is due Friday
    expect(await recordReminders(db, at("2026-11-07T09:00:00Z"))).toBe(0);
    expect(await recordReminders(db, at("2026-11-06T09:00:00Z"))).toBe(2);
  });

  it("ask decider and proposer to review a decision on its review date, once, unless it was replaced", async () => {
    const id = await submitted(draftInput({ feedbackGiverIds: [amy.personId], reviewDate: "2026-11-14" })); // a Saturday
    await postResponse(db, amy, id, { kind: "feedback", text: "Fine." }, WEDNESDAY);
    await startObjectionRound(db, ada, id, WEDNESDAY);
    await giveGo(db, amy, id, { version: 1 }, WEDNESDAY);
    await publishDecision(db, dan, id, publishSchema.parse({ summary: "We do it.", finalText: "Yes.", rationale: "Focus.", personalDataConfirmed: "on" }), WEDNESDAY);

    expect(await recordReminders(db, at("2026-11-13T09:00:00Z"))).toBe(0);
    expect(await recordReminders(db, at("2026-11-16T09:00:00Z"))).toBe(2); // the Monday after
    expect(await recordReminders(db, at("2026-11-16T10:00:00Z"))).toBe(0);
    expect(ids(await deliveries("reminder.review"))).toEqual(sorted(ada, dan));

    const other = await submitted(draftInput({ feedbackGiverIds: [], reviewDate: "2026-11-23" }));
    await db.update(entry).set({ supersededById: id }).where(eq(entry.id, other));
    await db.update(entry).set({ status: "decided" }).where(eq(entry.id, other));
    expect(await recordReminders(db, at("2026-11-23T09:00:00Z"))).toBe(0);
  });

  it("ask the decider and the author of a logged decision to review it", async () => {
    const decision = decisionInputSchema.parse({
      type: "decision",
      impact: "small",
      reversibility: "two_way",
      title: "Logged",
      teamId: seed.teams.tech.id,
      summary: "s",
      decisionText: "d",
      rationale: "r",
      deciderId: dan.personId,
      howDecided: "role_decision",
      decidedOn: "2026-11-03",
      reviewDate: "2026-11-16",
      personalDataConfirmed: "on",
    });
    await logDecision(db, amy, decision, WEDNESDAY);
    expect(await recordReminders(db, at("2026-11-13T09:00:00Z"))).toBe(0);
    expect(await recordReminders(db, at("2026-11-16T09:00:00Z"))).toBe(2);
    expect(ids(await deliveries("reminder.review"))).toEqual(sorted(amy, dan));
  });

  it("still ask for a review when the decision was published long after its review date", async () => {
    const id = await submitted(draftInput({ feedbackGiverIds: [amy.personId], reviewDate: "2026-11-05" }));
    await postResponse(db, amy, id, { kind: "feedback", text: "Fine." }, WEDNESDAY);
    await startObjectionRound(db, ada, id, WEDNESDAY);
    await giveGo(db, amy, id, { version: 1 }, WEDNESDAY);
    const late = at("2026-11-20T13:00:00Z"); // a Friday, after the 09:00 run, 15 days after the review date
    await publishDecision(db, dan, id, publishSchema.parse({ summary: "We do it.", finalText: "Yes.", rationale: "Focus.", personalDataConfirmed: "on" }), late);
    expect(await recordReminders(db, at("2026-11-21T09:00:00Z"))).toBe(0); // Saturday
    expect(await recordReminders(db, at("2026-11-23T09:00:00Z"))).toBe(2); // the next working day
    expect(await recordReminders(db, at("2026-11-24T09:00:00Z"))).toBe(0);
  });

  it("remind the decider after a proposal was ready for 2 working days", async () => {
    const id = await inObjectionRound();
    await giveGo(db, amy, id, { version: 1 }, WEDNESDAY);
    expect(await recordReminders(db, at("2026-11-05T09:00:00Z"))).toBe(0);
    expect(await recordReminders(db, at("2026-11-06T09:00:00Z"))).toBe(1);
    expect(ids(await deliveries("reminder.ready"))).toEqual([dan.personId]);
  });
});

function fakeTransports(options: { slackUsers?: Record<string, string>; email?: boolean; failSlack?: DeliveryError; failEmail?: DeliveryError } = {}) {
  const slackMessages: { userId: string; text: string }[] = [];
  const emails: Email[] = [];
  const lookups: string[] = [];
  const slack: SlackTransport = {
    mode: "live",
    async lookupUserByEmail(email) {
      lookups.push(email);
      return options.slackUsers?.[email] ?? null;
    },
    async postMessage(userId, text) {
      if (options.failSlack) throw options.failSlack;
      slackMessages.push({ userId, text });
    },
  };
  const transports: Transports = {
    baseUrl: "https://logbuch.example",
    slack,
    slackChannelId: "C_LOGBUCH",
    email:
      options.email === false
        ? undefined
        : {
            mode: "live",
            kind: "test",
            async send(email) {
              if (options.failEmail) throw options.failEmail;
              emails.push(email);
            },
          },
  };
  return { transports, slackMessages, emails, lookups };
}

const users = { "amy@example.org": "U_AMY", "dan@example.org": "U_DAN" };

describe("the worker's sender", () => {
  it("sends Slack messages, caches the Slack user, and emails people without a Slack account", async () => {
    const id = await submitted();
    const fake = fakeTransports({ slackUsers: users });
    expect(await dispatchDue(db, fake.transports, () => WEDNESDAY)).toEqual({ sent: 4, skipped: 0, retry: 0, failed: 0 });
    expect(fake.slackMessages.map((m) => m.userId).sort()).toEqual(["C_LOGBUCH", "U_AMY", "U_DAN"]);
    expect(fake.slackMessages.find((m) => m.userId === "C_LOGBUCH")!.text).toContain("Ada Author proposes a two-way decision. Feedback is open.");
    expect(fake.slackMessages[0]!.text).toMatch(/^\*<https:\/\/logbuch\.example\/e\/LB-\d+\|LB-\d+ · Four-day week>\*/);

    const people = new Map((await db.select().from(person)).map((p) => [p.id, p]));
    expect(people.get(amy.personId)).toMatchObject({ slackUserId: "U_AMY", slackLookupFailedAt: null });
    expect(people.get(eve.personId)?.slackLookupFailedAt).toEqual(WEDNESDAY);
    const toEve = (await deliveries()).find((d) => d.recipientId === eve.personId);
    expect(toEve).toMatchObject({ status: "sent", channel: "email", lastError: null });
    expect(fake.emails.map((e) => e.to)).toEqual(["eve@example.org"]);

    // Within a week, no new lookup for Eve; Amy's cached ID is used.
    await extendDeadline(db, ada, id, { phase: "feedback", deadline: "2026-11-09" }, WEDNESDAY);
    const lookupsBefore = fake.lookups.length;
    expect(await dispatchDue(db, fake.transports, () => WEDNESDAY)).toEqual({ sent: 2, skipped: 0, retry: 0, failed: 0 });
    expect(fake.lookups.length).toBe(lookupsBefore);
  });

  it("skips a Slack message for someone without a Slack account when email is off", async () => {
    await submitted();
    const fake = fakeTransports({ slackUsers: users, email: false });
    expect(await dispatchDue(db, fake.transports, () => WEDNESDAY)).toEqual({ sent: 3, skipped: 1, retry: 0, failed: 0 });
    const toEve = (await deliveries()).find((d) => d.recipientId === eve.personId);
    expect(toEve).toMatchObject({
      status: "skipped",
      channel: "slack",
      lastError: "No Slack account was found for this person's work email. Email is not configured.",
    });
  });

  it("emails event messages when Slack is off", async () => {
    await submitted();
    const fake = fakeTransports();
    const transports = { ...fake.transports, slack: undefined, slackChannelId: undefined };
    expect(await dispatchDue(db, transports, () => WEDNESDAY)).toMatchObject({ sent: 3, skipped: 1 }); // the channel post is skipped
    expect(fake.emails.map((e) => e.to).sort()).toEqual(["amy@example.org", "dan@example.org", "eve@example.org"]);
    expect(fake.emails[0]!.text).toContain("Feedback deadline: Friday, 06.11.2026, 23:59 (Europe/Amsterdam)");
  });

  it("sends reminders by email, by Slack when email is off, or skips them when neither reaches the person", async () => {
    await submitted();
    await recordReminders(db, at("2026-11-05T08:00:00Z"));
    const on = fakeTransports({ slackUsers: users });
    await dispatchDue(db, on.transports, () => at("2026-11-05T08:00:00Z"));
    const reminders = on.emails.filter((e) => e.subject.startsWith("Reminder"));
    expect(reminders.map((e) => e.to).sort()).toEqual(["amy@example.org", "eve@example.org"]);
    expect(reminders[0]!.subject).toMatch(/^Reminder: feedback due: LB-\d+ Four-day week$/);

    await db.update(notificationDelivery).set({ status: "pending", sentAt: null }).where(eq(notificationDelivery.event, "reminder.deadline"));
    const slackOnly = fakeTransports({ email: false, slackUsers: users });
    await dispatchDue(db, slackOnly.transports, () => at("2026-11-05T09:00:00Z"));
    expect((await deliveries("reminder.deadline")).map((d) => [d.recipientId, d.status, d.channel, d.lastError])).toEqual([
      [amy.personId, "sent", "slack", null],
      [eve.personId, "skipped", "email", "Email is not configured. No Slack account was found for this person's work email."],
    ]);
    expect(slackOnly.slackMessages.map((m) => m.userId)).toContain("U_AMY");
  });

  it("retries with backoff and gives up after 5 attempts", async () => {
    await submitProposalFor(dan);
    const fake = fakeTransports({
      slackUsers: users,
      email: false,
      failSlack: new DeliveryError("Slack chat.postMessage: internal_error", { code: "internal_error" }),
    });
    let now = WEDNESDAY;
    expect(await dispatchDue(db, fake.transports, () => now)).toMatchObject({ retry: 2 }); // the decider and the channel
    expect(await dispatchDue(db, fake.transports, () => now)).toMatchObject({ retry: 0 }); // not due yet
    const [first] = await deliveries("proposal.submitted");
    expect(first).toMatchObject({ status: "pending", attempts: 1, lastError: "Slack chat.postMessage: internal_error" });
    expect(first!.nextAttemptAt).toEqual(new Date(WEDNESDAY.getTime() + 60_000));

    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      await dispatchDue(db, fake.transports, () => now);
    }
    const [last] = await deliveries("proposal.submitted");
    expect(last).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      // The last attempt tried email too.
      lastError: "Slack chat.postMessage: internal_error. Email is not configured.",
    });
  });

  it("sends on the other channel at once after a permanent error", async () => {
    await submitProposalFor(dan);
    const fake = fakeTransports({ slackUsers: users, failSlack: new DeliveryError("Slack chat.postMessage: invalid_auth", { code: "invalid_auth", permanent: true }) });
    expect(await dispatchDue(db, fake.transports, () => WEDNESDAY)).toEqual({ sent: 1, skipped: 0, retry: 1, failed: 0 }); // the channel post has no other channel
    const toDan = (await deliveries("proposal.submitted")).find((d) => d.recipientId === dan.personId);
    expect(toDan).toMatchObject({ status: "sent", channel: "email", attempts: 1, lastError: "Slack chat.postMessage: invalid_auth." });
    expect(fake.emails.map((e) => e.to)).toEqual(["dan@example.org"]);
  });

  it("retries a temporary error on the planned channel, and tries the other one on the last attempt", async () => {
    await submitted(draftInput({ feedbackGiverIds: [amy.personId] }));
    await recordReminders(db, at("2026-11-05T08:00:00Z"));
    const fake = fakeTransports({ slackUsers: users, failEmail: new DeliveryError("SMTP 421: Try again later", { code: "EENVELOPE" }) });
    let now = at("2026-11-05T08:00:00Z");
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await dispatchDue(db, fake.transports, () => now);
      now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    }
    const [pending] = await deliveries("reminder.deadline");
    expect(pending).toMatchObject({ recipientId: amy.personId, status: "pending", attempts: MAX_ATTEMPTS - 1, lastError: "SMTP 421: Try again later" });
    const slackBefore = fake.slackMessages.length;

    await dispatchDue(db, fake.transports, () => now);
    const [last] = await deliveries("reminder.deadline");
    expect(last).toMatchObject({ status: "sent", channel: "slack", attempts: MAX_ATTEMPTS, lastError: "SMTP 421: Try again later." });
    expect(fake.slackMessages.slice(slackBefore).map((m) => m.userId)).toEqual(["U_AMY"]);
  });

  it("waits as long as the other channel asks when both fail", async () => {
    await submitProposalFor(dan);
    const fake = fakeTransports({
      slackUsers: users,
      failSlack: new DeliveryError("Slack chat.postMessage: invalid_auth", { code: "invalid_auth", permanent: true }),
      failEmail: new DeliveryError("MailerSend: HTTP 429", { retryAfterMs: 2 * 60 * 60 * 1000 }),
    });
    await dispatchDue(db, fake.transports, () => WEDNESDAY);
    const toDan = (await deliveries("proposal.submitted")).find((d) => d.recipientId === dan.personId);
    expect(toDan).toMatchObject({ status: "pending", attempts: 1, lastError: "Slack chat.postMessage: invalid_auth. MailerSend: HTTP 429." });
    expect(toDan!.nextAttemptAt).toEqual(new Date(WEDNESDAY.getTime() + 2 * 60 * 60 * 1000));
  });

  it("keeps retrying a permanent error when the other channel cannot reach the person", async () => {
    await submitProposalFor(dan);
    const fake = fakeTransports({
      slackUsers: users,
      email: false,
      failSlack: new DeliveryError("Slack chat.postMessage: invalid_auth", { code: "invalid_auth", permanent: true }),
    });
    await dispatchDue(db, fake.transports, () => WEDNESDAY);
    const toDan = (await deliveries("proposal.submitted")).find((d) => d.recipientId === dan.personId);
    expect(toDan).toMatchObject({ status: "pending", attempts: 1, lastError: "Slack chat.postMessage: invalid_auth. Email is not configured." });
  });

  it("looks up people without a Slack account again after a week", async () => {
    await db.update(person).set({ slackLookupFailedAt: at("2026-10-27T09:00:00Z") }).where(eq(person.id, amy.personId));
    await db.update(person).set({ slackLookupFailedAt: at("2026-11-01T09:00:00Z") }).where(eq(person.id, eve.personId));
    const fake = fakeTransports({ slackUsers: { ...users, "eve@example.org": "U_EVE" } });
    expect(await retrySlackLookups(db, fake.transports, WEDNESDAY)).toBe(1);
    expect(fake.lookups).toEqual(["amy@example.org"]);
    const people = new Map((await db.select().from(person)).map((p) => [p.id, p]));
    expect(people.get(amy.personId)).toMatchObject({ slackUserId: "U_AMY", slackLookupFailedAt: null });
    expect(people.get(eve.personId)).toMatchObject({ slackUserId: null, slackLookupFailedAt: at("2026-11-01T09:00:00Z") });
  });

  it("drops a Slack lookup when the directory sync changed the work email meanwhile", async () => {
    await db.update(person).set({ slackLookupFailedAt: at("2026-10-27T09:00:00Z") }).where(eq(person.id, amy.personId));
    await submitProposalFor(amy);
    // The directory sync changes Amy's email (and clears her lookup state) while Slack answers.
    const changeEmail = () =>
      db.update(person).set({ workEmail: "amy.new@example.org", slackUserId: null, slackLookupFailedAt: null }).where(eq(person.id, amy.personId));
    const racing = (found: string | null): SlackTransport => ({
      mode: "live",
      async lookupUserByEmail() {
        await changeEmail();
        return found;
      },
      postMessage: async () => undefined,
    });

    expect(await retrySlackLookups(db, { baseUrl: "https://logbuch.example", slack: racing("U_OLD") }, WEDNESDAY)).toBe(0);
    let [amyRow] = await db.select().from(person).where(eq(person.id, amy.personId));
    expect(amyRow).toMatchObject({ workEmail: "amy.new@example.org", slackUserId: null, slackLookupFailedAt: null });

    await db.update(person).set({ workEmail: "amy@example.org" }).where(eq(person.id, amy.personId));
    expect(await dispatchDue(db, { baseUrl: "https://logbuch.example", slack: racing(null) }, () => WEDNESDAY)).toMatchObject({ retry: 1 });
    [amyRow] = await db.select().from(person).where(eq(person.id, amy.personId));
    expect(amyRow).toMatchObject({ slackUserId: null, slackLookupFailedAt: null });
  });

  it("counts every failed message for the admin page, and lists the latest 20", async () => {
    await submitProposalFor(dan);
    const [first] = await deliveries("proposal.submitted");
    await db.insert(notificationDelivery).values(
      Array.from({ length: 21 }, (_, i) => ({ ...first!, id: undefined, deliveryKey: `failed:${i}`, status: "failed" as const, createdAt: WEDNESDAY })),
    );
    const status = await getNotificationStatus(db, WEDNESDAY);
    expect(status.failedTotal).toBe(21);
    expect(status.failed).toHaveLength(20);
    expect(status.lastWeek.slack).toMatchObject({ pending: 1, failed: 21 });
  });

  it("forgets a stale Slack user ID, and emails the message instead", async () => {
    await submitProposalFor(dan);
    await db.update(person).set({ slackUserId: "U_GONE" }).where(eq(person.id, dan.personId));
    const fake = fakeTransports({
      failSlack: new DeliveryError("Slack chat.postMessage: channel_not_found", { code: "channel_not_found", permanent: true }),
    });
    await dispatchDue(db, fake.transports, () => WEDNESDAY);
    const [dan2] = await db.select().from(person).where(eq(person.id, dan.personId));
    expect(dan2!.slackUserId).toBeNull();
    expect(fake.emails.map((e) => e.to)).toEqual(["dan@example.org"]);
  });
});

/** A proposal whose only notification goes to the decider. */
async function submitProposalFor(decider: Actor) {
  return submitted(draftInput({ feedbackGiverIds: [], deciderId: decider.personId }));
}

describe("the Logbuch Slack channel", () => {
  const update = () =>
    createNote(
      db,
      ada,
      noteInputSchema.parse({
        type: "update",
        impact: "small",
        title: "Stand-up moves",
        teamId: seed.teams.tech.id,
        tagIds: [],
        summary: "The stand-up moves to 10:00.",
        body: "",
        links: [],
        relatedIds: [],
        personalDataConfirmed: "on",
      }),
      WEDNESDAY,
    );

  it("gets one post per published update, sent to the configured channel or skipped without one", async () => {
    await update();
    const [post] = await deliveries("channel.update");
    expect(post).toMatchObject({ recipientId: null, channel: "slack_channel", status: "pending" });

    const fake = fakeTransports();
    await dispatchDue(db, fake.transports, () => WEDNESDAY);
    expect(fake.slackMessages).toEqual([{ userId: "C_LOGBUCH", text: expect.stringContaining("Ada Author posted an update.") }]);

    await update();
    await dispatchDue(db, { ...fake.transports, slackChannelId: undefined }, () => WEDNESDAY);
    const second = (await deliveries("channel.update")).find((d) => d.id !== post!.id);
    expect(second).toMatchObject({ status: "skipped", lastError: "No Slack channel is configured (SLACK_CHANNEL_ID)." });
  });

  it("shows the summary, impact, and affected teams in each post, for proposals too", async () => {
    const id = await submitted(draftInput({ summary: "Try a four-day week.", impact: "large", affectedTeamIds: [seed.teams.ops.id] }));
    const [post] = await deliveries("channel.submitted");
    expect(post!.entryId).toBe(id);
    expect(post!.message.post).toEqual({ type: "Decision", summary: "Try a four-day week.", impact: "Large", mustRead: true, affectedTeams: ["Operations"] });

    const fake = fakeTransports();
    await dispatchDue(db, fake.transports, () => WEDNESDAY);
    const text = fake.slackMessages.find((m) => m.userId === "C_LOGBUCH")!.text;
    expect(text).toMatch(/^\*Must read\* · /);
    expect(text).toContain(">Try a four-day week.");
    expect(text).toContain("Decision · Impact: Large · Affected teams: Operations");
  });

  it("gets one post per logged decision and learning, but none for imported old decisions", async () => {
    const decision = decisionInputSchema.parse({
      type: "decision",
      impact: "small",
      reversibility: "two_way",
      title: "Old decision from the earlier log",
      teamId: seed.teams.tech.id,
      summary: "s",
      decisionText: "d",
      rationale: "r",
      deciderId: dan.personId,
      howDecided: "other",
      decidedOn: "2026-11-03",
      personalDataConfirmed: "on",
    });
    await logDecision(db, amy, decision, WEDNESDAY, { announce: false, importedFrom: { source: "csv", externalId: "OLD-1" } });
    await logDecision(db, amy, { ...decision, title: "New decision" }, WEDNESDAY);
    await createNote(
      db,
      ada,
      noteInputSchema.parse({ type: "learning", impact: "medium", title: "Retro", teamId: seed.teams.tech.id, summary: "Ship smaller.", personalDataConfirmed: "on" }),
      WEDNESDAY,
    );
    const posts = (await db.select().from(notificationDelivery).where(eq(notificationDelivery.channel, "slack_channel"))).map((d) => [
      d.event,
      d.message.subject,
      d.message.post?.impact,
    ]);
    expect(posts).toEqual([
      ["channel.decision", "Decision logged: LB-2 New decision", "Small"],
      ["channel.learning", "New learning: LB-3 Retro", "Medium"],
    ]);
  });
});

