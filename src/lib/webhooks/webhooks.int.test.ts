import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { webhookState } from "@/lib/db/schema";
import { addAddendum, changeImpact, logDecision, createNote, editNote, type Actor } from "@/lib/entries/commands";
import { decisionInputSchema, noteInputSchema, type DecisionInput, type NoteInput } from "@/lib/entries/schemas";
import {
  postResponse,
  publishDecision,
  rejectProposal,
  saveDraft,
  startObjectionRound,
  submitProposal,
  withdrawProposal,
} from "@/lib/process/commands";
import { proposalDraftSchema, publishSchema } from "@/lib/process/schemas";
import { WebhookError, type WebhookClient } from "./client";
import type { WebhookPayload } from "./payload";
import { reconcileWebhook, requestWebhook, syncRequested } from "./sync";

const testDb = connectTestDatabase();
const { db } = testDb;
let seed: Awaited<ReturnType<typeof seedDirectory>>;
let ada: Actor;
let dan: Actor;
let amy: Actor;

const BASE = "https://logbuch.example";
const WEDNESDAY = new Date("2026-11-04T09:00:00Z");
const later = (minutes: number) => new Date(WEDNESDAY.getTime() + minutes * 60_000);

beforeEach(async () => {
  await testDb.reset();
  seed = await seedDirectory(db);
  ada = seed.actors.ada;
  dan = seed.actors.dan;
  amy = seed.actors.amy;
});
afterAll(() => testDb.close());

const updateInput = (overrides: Record<string, unknown> = {}): NoteInput =>
  noteInputSchema.parse({
    type: "update",
    impact: "small",
    title: "New onboarding checklist",
    teamId: seed.teams.tech.id,
    tagIds: [],
    summary: "We use one checklist for every new colleague.",
    body: "The checklist lives in the wiki.",
    links: [],
    relatedIds: [],
    personalDataConfirmed: "on",
    ...overrides,
  });

const recordInput = (overrides: Record<string, unknown> = {}): DecisionInput =>
  decisionInputSchema.parse({
    type: "decision",
    impact: "medium",
    reversibility: "two_way",
    title: "Laptop budget per person",
    teamId: seed.teams.ops.id,
    tagIds: [],
    summary: "Each new laptop may cost up to 1,600 EUR.",
    links: [],
    decisionText: "The laptop budget is 1,600 EUR per person.",
    rationale: "Prices rose.",
    deciderId: seed.people.dan.id,
    involvedIds: [],
    howDecided: "role_decision",
    decidedOn: "2026-11-02",
    personalDataConfirmed: "on",
    ...overrides,
  });

/** Records every payload; can fail or run code while the receiver answers. */
function fakeReceiver(options: { fail?: boolean; during?: () => Promise<void> } = {}) {
  const sent: WebhookPayload[] = [];
  const client: WebhookClient = {
    async send(payload) {
      await options.during?.();
      if (options.fail) throw new WebhookError("The webhook answered HTTP 503");
      sent.push(payload);
    },
  };
  return { client, sent };
}

async function state(entryId: string) {
  const [row] = await db.select().from(webhookState).where(eq(webhookState.entryId, entryId));
  return row;
}

describe("webhook", () => {
  it("sends a published update once, and again only when it changes", async () => {
    const update = await createNote(db, ada, updateInput(), WEDNESDAY);
    expect((await state(update!.id))?.requestedAt).toEqual(WEDNESDAY);

    const receiver = fakeReceiver();
    expect(await syncRequested(db, receiver.client, BASE, later(1))).toMatchObject({ sent: 1 });
    expect(receiver.sent[0]).toMatchObject({ event: "entry.changed", entry: { type: "update", id: update!.id, url: expect.stringMatching(/^https:\/\/logbuch\.example\/e\/LB-\d+$/) } });
    expect(await state(update!.id)).toMatchObject({ requestedAt: null, deliveredAt: later(1), lastError: null });

    // Requested again without a change: nothing is sent.
    await requestWebhook(db, update!.id, later(2));
    expect(await syncRequested(db, receiver.client, BASE, later(3))).toMatchObject({ sent: 0, unchanged: 1 });

    await editNote(db, ada, update!.id, updateInput({ body: "The checklist moved to the handbook." }), later(4));
    expect(await syncRequested(db, receiver.client, BASE, later(5))).toMatchObject({ sent: 1 });
    expect(receiver.sent[1]!.entry.details).toBe("The checklist moved to the handbook.");
  });

  it("re-sends an entry whose impact changed", async () => {
    const update = await createNote(db, ada, updateInput(), WEDNESDAY);
    const receiver = fakeReceiver();
    await syncRequested(db, receiver.client, BASE, later(1));
    await changeImpact(db, ada, update!.id, "large", later(2));
    expect(await syncRequested(db, receiver.client, BASE, later(3))).toMatchObject({ sent: 1 });
    expect(receiver.sent[1]!.entry).toMatchObject({ type: "update", impact: "large" });
  });

  it("re-sends a replaced logged decision as no longer in force", async () => {
    const old = await logDecision(db, ada, recordInput(), WEDNESDAY);
    const receiver = fakeReceiver();
    await syncRequested(db, receiver.client, BASE, later(1));
    const replacement = await logDecision(db, ada, recordInput({ title: "Laptop budget 2027", supersedesId: old!.id }), later(2));
    await syncRequested(db, receiver.client, BASE, later(3));
    const byId = new Map(receiver.sent.map((p) => [p.entry.id, p]));
    expect(receiver.sent).toHaveLength(3);
    expect(byId.get(old!.id)?.entry).toMatchObject({ in_force: false, superseded_by: expect.stringMatching(/^LB-\d+$/) });
    expect(byId.get(replacement!.id)?.entry).toMatchObject({ in_force: true, supersedes: expect.stringMatching(/^LB-\d+$/) });

    await addAddendum(db, dan, replacement!.id, { text: "Applies from January.", personalDataConfirmed: "on" }, later(4));
    await syncRequested(db, receiver.client, BASE, later(5));
    expect(receiver.sent).toHaveLength(4);
    expect(receiver.sent[3]!.entry.addenda.map((a) => [a.text, a.author])).toEqual([["Applies from January.", "Dan Decider"]]);
  });

  it("sends rejected proposals, never withdrawn proposals", async () => {
    const input = proposalDraftSchema.parse({
      title: "Four-day week",
      question: "Should we try it?",
      body: "Focus.",
      impact: "medium",
      proposalText: "We try it.",
      reversibility: "two_way",
      deciderId: dan.personId,
      feedbackGiverIds: [amy.personId],
      teamId: seed.teams.tech.id,
      objectionPeriodDays: "1",
      feedbackDeadline: "2026-11-06",
    });
    const rejected = await saveDraft(db, ada, input, undefined, WEDNESDAY);
    await submitProposal(db, ada, rejected.id, WEDNESDAY);
    await postResponse(db, amy, rejected.id, { kind: "feedback", text: "Fine." }, WEDNESDAY);
    await startObjectionRound(db, ada, rejected.id, WEDNESDAY);
    await rejectProposal(db, dan, rejected.id, { rationale: "Not now." }, WEDNESDAY);
    const withdrawn = await saveDraft(db, ada, input, undefined, WEDNESDAY);
    await submitProposal(db, ada, withdrawn.id, WEDNESDAY);
    await withdrawProposal(db, ada, withdrawn.id, {}, WEDNESDAY);

    const receiver = fakeReceiver();
    await syncRequested(db, receiver.client, BASE, later(1));
    expect(receiver.sent.map((p) => [p.entry.id, p.entry.status, p.entry.in_force, p.entry.decision?.result, p.entry.decision?.text])).toEqual([
      [rejected.id, "rejected", false, "rejected", ""],
    ]);
    expect(await state(withdrawn.id)).toBeUndefined();
  });

  it("sends a two-way decision with the objections still open when it was published", async () => {
    const draft = await saveDraft(
      db,
      ada,
      proposalDraftSchema.parse({
        title: "Four-day week",
        question: "Should we try it?",
        body: "Focus.",
        impact: "medium",
        proposalText: "We try it.",
        reversibility: "two_way",
        deciderId: dan.personId,
        feedbackGiverIds: [amy.personId],
        teamId: seed.teams.tech.id,
        objectionPeriodDays: "1",
        feedbackDeadline: "2026-11-06",
      }),
      undefined,
      WEDNESDAY,
    );
    await submitProposal(db, ada, draft.id, WEDNESDAY);
    await postResponse(db, amy, draft.id, { kind: "feedback", text: "Fine." }, WEDNESDAY);
    await startObjectionRound(db, ada, draft.id, WEDNESDAY); // objection deadline: Thursday
    await postResponse(db, amy, draft.id, { kind: "objection", text: "Support on Fridays is thin." }, WEDNESDAY);
    const friday = new Date("2026-11-06T09:00:00Z");
    const publish = publishSchema.parse({
      summary: "The tech team tries a four-day week.",
      finalText: "We try it for three months.",
      rationale: "Focus matters.",
      objectionHandling: "A rota covers Fridays.",
      personalDataConfirmed: "on",
    });
    await publishDecision(db, dan, draft.id, publish, friday);

    const receiver = fakeReceiver();
    await syncRequested(db, receiver.client, BASE, friday);
    expect(receiver.sent[0]).toMatchObject({
      entry: {
        type: "decision",
        status: "decided",
        impact: "medium",
        in_force: true,
        author: "Ada Author",
        summary: "The tech team tries a four-day week.",
        rationale: "Focus matters.",
        decision: {
          result: "adopted",
          text: "We try it for three months.",
          reversibility: "two_way",
          how_decided: "integrative_process",
          decider: "Dan Decider",
          objection_handling: "A rota covers Fridays.",
          open_objections: ["Support on Fridays is thin."],
          proposal_version: 1,
        },
      },
    });
  });

  it("retries a failed send with growing pauses", async () => {
    const update = await createNote(db, ada, updateInput(), WEDNESDAY);
    const failing = fakeReceiver({ fail: true });
    expect(await syncRequested(db, failing.client, BASE, later(1))).toMatchObject({ failed: 1 });
    expect(await state(update!.id)).toMatchObject({ attempts: 1, lastError: "The webhook answered HTTP 503", nextAttemptAt: later(2), requestedAt: WEDNESDAY });
    expect(await syncRequested(db, failing.client, BASE, later(1.5))).toMatchObject({ failed: 0 }); // not due yet
    await syncRequested(db, failing.client, BASE, later(2));
    expect((await state(update!.id))?.nextAttemptAt).toEqual(later(7));

    const working = fakeReceiver();
    expect(await syncRequested(db, working.client, BASE, later(7))).toMatchObject({ sent: 1 });
    expect(await state(update!.id)).toMatchObject({ attempts: 0, lastError: null, requestedAt: null });
  });

  it("keeps a request that arrives while the receiver answers", async () => {
    const update = await createNote(db, ada, updateInput(), WEDNESDAY);
    const receiver = fakeReceiver({ during: () => requestWebhook(db, update!.id, later(1)) });
    await syncRequested(db, receiver.client, BASE, later(2));
    expect((await state(update!.id))?.requestedAt).toEqual(later(1));
  });

  it("never sends an entry from two runs at once, and the newest content goes last", async () => {
    const update = await createNote(db, ada, updateInput({ body: "Old body." }), WEDNESDAY);
    const other = fakeReceiver();
    let edited = false;
    const receiver = fakeReceiver({
      during: async () => {
        if (edited) return;
        edited = true;
        // While the first run sends the old body: an edit, and a second run.
        await editNote(db, ada, update!.id, updateInput({ body: "New body." }), later(1));
        await syncRequested(db, other.client, BASE, later(1));
      },
    });
    await syncRequested(db, receiver.client, BASE, later(1));
    expect(other.sent).toHaveLength(0);
    expect(receiver.sent.map((p) => p.entry.details)).toEqual(["Old body."]);
    expect((await state(update!.id))?.requestedAt).toEqual(later(1));

    await syncRequested(db, receiver.client, BASE, later(2));
    expect(receiver.sent[1]!.entry.details).toBe("New body.");
    expect(await state(update!.id)).toMatchObject({ requestedAt: null, leaseOwner: null, leaseUntil: null });
  });

  it("keeps a newer request's fresh retry state when an older attempt fails", async () => {
    const update = await createNote(db, ada, updateInput(), WEDNESDAY);
    await db.update(webhookState).set({ attempts: 3 }).where(eq(webhookState.entryId, update!.id));
    const failing = fakeReceiver({ fail: true, during: () => requestWebhook(db, update!.id, later(1)) });
    expect(await syncRequested(db, failing.client, BASE, later(1))).toMatchObject({ failed: 1 });
    expect(await state(update!.id)).toMatchObject({
      requestedAt: later(1),
      attempts: 0,
      nextAttemptAt: null,
      lastError: "The webhook answered HTTP 503",
      leaseOwner: null,
    });
  });

  it("waits for another run's lease on the database clock, and takes over once it has ended", async () => {
    await createNote(db, ada, updateInput(), WEDNESDAY);
    await db.execute(sql`update webhook_state set lease_owner = 'crashed-run', lease_until = clock_timestamp() + interval '5 minutes'`);
    const receiver = fakeReceiver();
    // A worker whose clock (or job start time) is far ahead does not take over.
    expect(await syncRequested(db, receiver.client, BASE, later(60 * 24))).toMatchObject({ sent: 0 });
    await db.execute(sql`update webhook_state set lease_until = clock_timestamp() - interval '1 second'`);
    expect(await syncRequested(db, receiver.client, BASE, later(1))).toMatchObject({ sent: 1 });
  });

  it("does not let a run with a later clock take over a send in progress", async () => {
    const update = await createNote(db, ada, updateInput({ body: "Old body." }), WEDNESDAY);
    const other = fakeReceiver();
    let started = false;
    const receiver = fakeReceiver({
      during: async () => {
        if (started) return;
        started = true;
        await editNote(db, ada, update!.id, updateInput({ body: "New body." }), later(1));
        // A long batch's job time, or a skewed worker clock: hours later.
        await syncRequested(db, other.client, BASE, later(600));
      },
    });
    await syncRequested(db, receiver.client, BASE, later(1));
    expect(other.sent).toHaveLength(0);
    await syncRequested(db, receiver.client, BASE, later(2));
    expect(receiver.sent.map((p) => p.entry.details)).toEqual(["Old body.", "New body."]);
  });

  it("sends every entry the receiver has not seen in the nightly run, then nothing", async () => {
    await createNote(db, ada, updateInput(), WEDNESDAY);
    await logDecision(db, ada, recordInput(), WEDNESDAY);
    // As if the webhook was configured only now: no state yet.
    await db.execute("truncate webhook_state" as never);
    const receiver = fakeReceiver();
    expect(await reconcileWebhook(db, receiver.client, BASE, later(1))).toMatchObject({ requested: 2, sent: 2 });
    expect(await reconcileWebhook(db, receiver.client, BASE, later(2))).toMatchObject({ requested: 0, sent: 0 });
  });

  it("never deletes delivery state", async () => {
    await createNote(db, ada, updateInput(), WEDNESDAY);
    await expect(db.delete(webhookState)).rejects.toThrow();
  });
});
