import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { auditEvent, entry, entryRevision, entryTag, outcome, participant, person } from "@/lib/db/schema";
import { saveDraft } from "@/lib/process/commands";
import { proposalDraftSchema } from "@/lib/process/schemas";
import { consumeRateLimit, RateLimitError } from "@/lib/rate-limit";
import {
  addAddendum,
  changeImpact,
  logDecision,
  createTag,
  createNote,
  editNote,
  EntryError,
  renameTag,
  setTagActive,
} from "./commands";
import { getEntryByNumber, getEntryHistory, listTimeline, parseTimelineFilters, searchEntries, searchEntriesForPicker } from "./queries";
import {
  decisionInputSchema,
  noteInputSchema,
  type DecisionInput,
  type NoteInput,
} from "./schemas";

const testDb = connectTestDatabase();
const { db } = testDb;
let seed: Awaited<ReturnType<typeof seedDirectory>>;

beforeEach(async () => {
  await testDb.reset();
  seed = await seedDirectory(db);
});
afterAll(() => testDb.close());

function updateInput(overrides: Partial<Record<keyof NoteInput, unknown>> = {}): NoteInput {
  return noteInputSchema.parse({
    type: "update",
    impact: "small",
    title: "New onboarding checklist",
    teamId: seed.teams.tech.id,
    tagIds: [seed.tags.budget.id],
    summary: "We use one checklist for every new colleague.",
    body: "The checklist lives in **the wiki**.",
    links: ["https://example.org/checklist"],
    relatedIds: [],
    personalDataConfirmed: "on",
    ...overrides,
  });
}

function recordInput(overrides: Partial<Record<keyof DecisionInput, unknown>> = {}): DecisionInput {
  return decisionInputSchema.parse({
    type: "decision",
    impact: "medium",
    reversibility: "two_way",
    title: "Laptop budget per person",
    teamId: seed.teams.ops.id,
    tagIds: [],
    summary: "Each new laptop may cost up to 1,600 EUR.",
    links: [],
    decisionText: "The laptop budget is 1,600 EUR per person.",
    rationale: "Prices rose; the old limit no longer covers the standard model.",
    deciderId: seed.people.dan.id,
    involvedIds: [seed.people.ada.id],
    howDecided: "role_decision",
    decidedOn: "2026-11-02",
    personalDataConfirmed: "on",
    ...overrides,
  });
}

async function expectEntryError(promise: Promise<unknown>, code: EntryError["code"], field?: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(EntryError);
  expect((error as EntryError).code).toBe(code);
  if (field) expect(Object.keys((error as EntryError).fieldErrors)).toContain(field);
}

describe("updates", () => {
  it("publishes an update with revision 1, tags, links, and an audit event", async () => {
    const created = await createNote(db, seed.actors.ada, updateInput());
    const detail = await getEntryByNumber(db, created.number);

    expect(created.number).toBe(1);
    expect(detail).toMatchObject({
      type: "update",
      impact: "small",
      status: "published",
      title: "New onboarding checklist",
      teamName: "Engineering",
      authorName: "Ada Author",
      links: [{ url: "https://example.org/checklist" }],
      editedAt: null,
    });
    expect(detail?.tags.map((t) => t.name)).toEqual(["Budget"]);
    expect(detail?.personalDataConfirmedAt).toBeInstanceOf(Date);
    const history = await getEntryHistory(db, created.id);
    expect(history.revisions.map((r) => r.revision)).toEqual([1]);
    expect(history.events.map((e) => e.action)).toEqual(["entry.published"]);
  });

  it("saves an edit by the author as a new revision and marks the update as edited", async () => {
    const created = await createNote(db, seed.actors.ada, updateInput());
    const revision = await editNote(
      db,
      seed.actors.ada,
      created.id,
      updateInput({ summary: "One checklist for everyone.", tagIds: [seed.tags.tools.id] }),
    );

    expect(revision).toBe(2);
    const detail = await getEntryByNumber(db, created.number);
    expect(detail?.summary).toBe("One checklist for everyone.");
    expect(detail?.editedAt).toBeInstanceOf(Date);
    expect(detail?.tags.map((t) => t.name)).toEqual(["Tools"]);
    const history = await getEntryHistory(db, created.id);
    expect(history.revisions.map((r) => [r.revision, r.summary, r.tagNames])).toEqual([
      [1, "We use one checklist for every new colleague.", ["Budget"]],
      [2, "One checklist for everyone.", ["Tools"]],
    ]);
    expect(history.events.map((e) => e.action)).toEqual(["entry.published", "entry.edited"]);
  });

  it("does not create a revision when nothing changed", async () => {
    const created = await createNote(db, seed.actors.ada, updateInput());
    await expect(editNote(db, seed.actors.ada, created.id, updateInput())).resolves.toBeUndefined();
    expect(await db.select().from(entryRevision)).toHaveLength(1);
  });

  it("lets only the author edit an update", async () => {
    const created = await createNote(db, seed.actors.ada, updateInput());
    await expectEntryError(editNote(db, seed.actors.amy, created.id, updateInput({ title: "Hijacked" })), "forbidden");
  });

  it("rejects inactive teams and tags and unknown related entries", async () => {
    await expectEntryError(createNote(db, seed.actors.ada, updateInput({ teamId: seed.teams.archive.id })), "invalid", "teamId");
    await expectEntryError(createNote(db, seed.actors.ada, updateInput({ tagIds: [seed.tags.old.id] })), "invalid", "tagIds");
    await expectEntryError(
      createNote(db, seed.actors.ada, updateInput({ relatedIds: ["01900000-0000-7000-8000-000000000000"] })),
      "invalid",
      "relatedIds",
    );
    expect(await db.select().from(entry)).toHaveLength(0);
  });

  it("keeps a team or tag that was deactivated after publishing when the update is edited", async () => {
    const created = await createNote(db, seed.actors.ada, updateInput());
    await setTagActive(db, seed.actors.amy, seed.tags.budget.id, false);
    await expect(editNote(db, seed.actors.ada, created.id, updateInput({ summary: "Still budget." }))).resolves.toBe(2);
    await expectEntryError(
      editNote(db, seed.actors.ada, created.id, updateInput({ tagIds: [seed.tags.old.id] })),
      "invalid",
      "tagIds",
    );
  });

  it("links related entries, but not to itself", async () => {
    const first = await createNote(db, seed.actors.ada, updateInput());
    const second = await createNote(db, seed.actors.ada, updateInput({ title: "Follow-up", relatedIds: [first.id] }));
    expect((await getEntryByNumber(db, second.number))?.related.map((r) => r.number)).toEqual([first.number]);
    await expectEntryError(editNote(db, seed.actors.ada, second.id, updateInput({ relatedIds: [second.id] })), "invalid", "relatedIds");
  });
});

describe("learnings", () => {
  it("are published like updates, with an optional rationale, and can switch to an update when edited", async () => {
    const created = await createNote(db, seed.actors.ada, updateInput({ type: "learning", rationale: "From the launch retro." }));
    expect(await getEntryByNumber(db, created.number)).toMatchObject({ type: "learning", rationale: "From the launch retro." });
    await editNote(db, seed.actors.ada, created.id, updateInput({ type: "update", rationale: "", affectedTeamIds: [seed.teams.ops.id] }));
    const history = await getEntryHistory(db, created.id);
    expect(history.revisions.map((r) => [r.type, r.rationale, r.affectedTeamNames])).toEqual([
      ["learning", "From the launch retro.", []],
      ["update", "", ["Operations"]],
    ]);
  });

  it("cannot turn a decision into an update", async () => {
    const decision = await logDecision(db, seed.actors.ada, recordInput());
    await expectEntryError(editNote(db, seed.actors.ada, decision.id, updateInput()), "not_found");
  });
});

describe("impact", () => {
  it("can be changed by the author, the decider, and an admin, and is recorded in the audit log", async () => {
    const decision = await logDecision(db, seed.actors.amy, recordInput({ involvedIds: [] }));
    await changeImpact(db, seed.actors.amy, decision.id, "large");
    await changeImpact(db, seed.actors.dan, decision.id, "small");
    await changeImpact(db, { ...seed.actors.ada, isAdmin: true }, decision.id, "medium");
    await expectEntryError(changeImpact(db, seed.actors.ada, decision.id, "large"), "forbidden");
    // Unchanged: no event.
    await changeImpact(db, seed.actors.amy, decision.id, "medium");
    expect((await getEntryByNumber(db, decision.number))?.impact).toBe("medium");
    const history = await getEntryHistory(db, decision.id);
    expect(history.events.filter((e) => e.action === "entry.impact_changed").map((e) => e.payload)).toEqual([
      { from: "medium", to: "large" },
      { from: "large", to: "small" },
      { from: "small", to: "medium" },
    ]);
  });
});

describe("logged decisions", () => {
  it("publishes the decision with its outcome, decider, and involved people", async () => {
    const created = await logDecision(db, seed.actors.ada, recordInput());
    const detail = await getEntryByNumber(db, created.number);

    expect(detail).toMatchObject({
      type: "decision",
      status: "published",
      isProposal: false,
      authorName: "Ada Author",
      impact: "medium",
      rationale: "Prices rose; the old limit no longer covers the standard model.",
    });
    expect(detail?.outcome).toMatchObject({
      result: "recorded",
      finalText: "The laptop budget is 1,600 EUR per person.",
      decidedOn: "2026-11-02",
      decidedByName: "Dan Decider",
    });
    expect(detail?.decision).toMatchObject({
      reversibility: "two_way",
      reversibilityReason: null,
      howDecided: "role_decision",
      deciderName: "Dan Decider",
      effectiveDate: null,
      reviewDate: null,
    });
    expect(detail?.involved.map((p) => p.name)).toEqual(["Ada Author"]);
  });

  it("keeps why a one-way decision is hard to reverse, with its dates and affected teams", async () => {
    const created = await logDecision(
      db,
      seed.actors.ada,
      recordInput({
        reversibility: "one_way",
        reversibilityReason: "Three-year contract.",
        effectiveDate: "2027-01-01",
        reviewDate: "2027-06-01",
        affectedTeamIds: [seed.teams.tech.id],
        body: "Laptops got expensive.",
      }),
    );
    const detail = await getEntryByNumber(db, created.number);
    expect(detail?.decision).toMatchObject({ reversibility: "one_way", reversibilityReason: "Three-year contract.", effectiveDate: "2027-01-01", reviewDate: "2027-06-01" });
    expect(detail?.affectedTeams.map((t) => t.name)).toEqual(["Engineering"]);
    expect(detail?.body).toBe("Laptops got expensive.");
  });

  it("only accepts people with access as decider or involved people", async () => {
    await expectEntryError(logDecision(db, seed.actors.ada, recordInput({ deciderId: seed.people.lea.id })), "invalid", "deciderId");
    await expectEntryError(
      logDecision(db, seed.actors.ada, recordInput({ involvedIds: [seed.people.lea.id] })),
      "invalid",
      "involvedIds",
    );
  });

  it("rejects a decision date in the future", async () => {
    await expectEntryError(
      logDecision(db, seed.actors.ada, recordInput({ decidedOn: "2026-11-05" }), new Date("2026-11-04T12:00:00Z")),
      "invalid",
      "decidedOn",
    );
  });

  it("flags the replaced decision as superseded; it keeps its status", async () => {
    const old = await logDecision(db, seed.actors.ada, recordInput());
    const replacement = await logDecision(db, seed.actors.dan, recordInput({ title: "Laptop budget 2027", supersedesId: old.id }));

    const oldDetail = await getEntryByNumber(db, old.number);
    expect(oldDetail).toMatchObject({ status: "published", supersededBy: { number: replacement.number } });
    expect((await getEntryByNumber(db, replacement.number))?.supersedes).toMatchObject({ number: old.number });
    const events = await db.select({ action: auditEvent.action }).from(auditEvent).where(eq(auditEvent.entryId, old.id));
    expect(events.map((e) => e.action)).toEqual(["entry.published", "entry.superseded"]);

    await expectEntryError(logDecision(db, seed.actors.dan, recordInput({ supersedesId: old.id })), "invalid", "supersedesId");
  });

  it("replaces a logged one-way decision only through a one-way proposal", async () => {
    const old = await logDecision(db, seed.actors.ada, recordInput({ reversibility: "one_way", reversibilityReason: "Contract." }));
    await expectEntryError(
      logDecision(db, seed.actors.dan, recordInput({ reversibility: "one_way", reversibilityReason: "x", supersedesId: old.id })),
      "invalid",
      "supersedesId",
    );
  });

  it("only replaces decisions", async () => {
    const update = await createNote(db, seed.actors.ada, updateInput());
    await expectEntryError(logDecision(db, seed.actors.ada, recordInput({ supersedesId: update.id })), "invalid", "supersedesId");
  });
});

describe("addenda", () => {
  it("can be added by the author, the decider, and an admin, but nobody else", async () => {
    const record = await logDecision(db, seed.actors.amy, recordInput({ involvedIds: [] }));
    await addAddendum(db, seed.actors.amy, record.id, { text: "From the author.", personalDataConfirmed: "on" });
    await addAddendum(db, seed.actors.dan, record.id, { text: "From the decider.", personalDataConfirmed: "on" });
    await addAddendum(db, { ...seed.actors.ada, isAdmin: true }, record.id, { text: "From an admin.", personalDataConfirmed: "on" });
    await expectEntryError(
      addAddendum(db, seed.actors.ada, record.id, { text: "From someone else.", personalDataConfirmed: "on" }),
      "forbidden",
    );
    const detail = await getEntryByNumber(db, record.number);
    expect(detail?.addenda.map((a) => [a.text, a.authorName])).toEqual([
      ["From the author.", "Amy Admin"],
      ["From the decider.", "Dan Decider"],
      ["From an admin.", "Ada Author"],
    ]);
  });

  it("is not possible on updates and learnings", async () => {
    const update = await createNote(db, seed.actors.ada, updateInput());
    await expectEntryError(addAddendum(db, seed.actors.ada, update.id, { text: "x", personalDataConfirmed: "on" }), "forbidden");
  });
});

describe("timeline", () => {
  async function publishSample() {
    const update = await createNote(db, seed.actors.ada, updateInput(), new Date("2026-11-02T09:00:00Z"));
    const record = await logDecision(
      db,
      seed.actors.ada,
      recordInput({ tagIds: [seed.tags.tools.id], affectedTeamIds: [seed.teams.tech.id] }),
      new Date("2026-11-03T22:30:00Z"), // Nov 3, 23:30 in Amsterdam
    );
    const german = await createNote(
      db,
      seed.actors.dan,
      updateInput({
        title: "Neue Regeln für Entscheidungen",
        teamId: seed.teams.ops.id,
        tagIds: [],
        summary: "Wir dokumentieren alle Entscheidungen im Logbuch.",
        body: "",
      }),
      new Date("2026-11-04T08:00:00Z"),
    );
    return { update, record, german };
  }

  const titles = async (params: Record<string, string>) =>
    (await listTimeline(db, parseTimelineFilters(params))).items.map((item) => item.title);

  it("lists entries newest first and filters by type, team, tag, and person", async () => {
    await publishSample();
    expect(await titles({})).toEqual(["Neue Regeln für Entscheidungen", "Laptop budget per person", "New onboarding checklist"]);
    expect(await titles({ type: "decision" })).toEqual(["Laptop budget per person"]);
    expect(await titles({ type: "learning" })).toEqual([]);
    expect(await titles({ status: "decided" })).toEqual(["Laptop budget per person"]);
    expect(await titles({ impact: "medium" })).toEqual(["Laptop budget per person"]);
    expect(await titles({ how: "role_decision", reversibility: "two_way" })).toEqual(["Laptop budget per person"]);
    expect(await titles({ how: "other" })).toEqual([]);
    expect(await titles({ affected: seed.teams.tech.id })).toEqual(["Laptop budget per person"]);
    expect(await titles({ team: seed.teams.ops.id })).toEqual(["Neue Regeln für Entscheidungen", "Laptop budget per person"]);
    expect(await titles({ tag: seed.tags.tools.id })).toEqual(["Laptop budget per person"]);
    // Dan is the decider of the record and the author of the German update.
    expect(await titles({ person: seed.people.dan.id })).toEqual(["Neue Regeln für Entscheidungen", "Laptop budget per person"]);
  });

  it("filters by calendar days in the server's time zone", async () => {
    await publishSample();
    expect(await titles({ from: "2026-11-03", to: "2026-11-03" })).toEqual(["Laptop budget per person"]);
    expect(await titles({ to: "2026-11-02" })).toEqual(["New onboarding checklist"]);
  });

  it("finds entries by English and German word forms, decision text, and LB number", async () => {
    const { update, record } = await publishSample();
    expect(await titles({ q: "checklists" })).toEqual(["New onboarding checklist"]);
    expect(await titles({ q: "Entscheidung" })).toEqual(["Neue Regeln für Entscheidungen"]);
    expect(await titles({ q: "standard model" })).toEqual(["Laptop budget per person"]); // rationale
    expect(await titles({ q: `LB-${update.number}` })).toEqual(["New onboarding checklist"]);
    await addAddendum(db, seed.actors.dan, record.id, { text: "Applies to monitors as well.", personalDataConfirmed: "on" });
    expect(await titles({ q: "monitors" })).toEqual(["Laptop budget per person"]);
  });

  it("finds entries from the start of the last word", async () => {
    await publishSample();
    expect(await titles({ q: "onboarding check" })).toEqual(["New onboarding checklist"]);
    expect(await titles({ q: "Entsch" })).toEqual(["Neue Regeln für Entscheidungen"]);
    expect(await titles({ q: "check onboarding" })).toEqual([]); // only the last word is a prefix
    expect(await titles({ q: "-!" })).toEqual([]);
    expect(await titles({ q: "onboarding\u0000check" })).toEqual(["New onboarding checklist"]); // no error
  });

  it("finds email addresses and hosts as one word, as PostgreSQL indexes them", async () => {
    await createNote(db, seed.actors.ada, updateInput({ title: "Support address", summary: "Write to help@example.org or see wiki.example.org." }));
    expect(await titles({ q: "help@example.org" })).toEqual(["Support address"]);
    expect(await titles({ q: "wiki.example" })).toEqual(["Support address"]);
  });

  it("searches for the sidebar: the typed number first, then title matches, never drafts", async () => {
    const { update } = await publishSample();
    // Newer than the decision, but "laptop" is only in its summary.
    await createNote(
      db,
      seed.actors.ada,
      updateInput({ title: "Monitors for everyone", summary: "Like the laptop budget, per person.", body: "" }),
      new Date("2026-11-05T08:00:00Z"),
    );
    await saveDraft(
      db,
      seed.actors.ada,
      proposalDraftSchema.parse({
        title: "Laptop draft",
        question: "Should laptops cost more?",
        reversibility: "two_way",
        deciderId: seed.people.dan.id,
        feedbackGiverIds: [],
        teamId: seed.teams.tech.id,
        objectionPeriodDays: "1",
      }),
    );
    const found = async (q: string) => (await searchEntries(db, q)).map((e) => e.title);
    expect(await found("lapt")).toEqual(["Laptop budget per person", "Monitors for everyone"]);
    expect((await searchEntries(db, String(update.number)))[0]).toMatchObject({ title: "New onboarding checklist", type: "update", isProposal: false });
    expect(await found(`LB-${update.number}`)).toContain("New onboarding checklist");
    expect(await found("")).toEqual([]);
  });

  it("pages through entries", async () => {
    for (let i = 0; i < 27; i += 1) await createNote(db, seed.actors.ada, updateInput({ title: `Update ${i}` }));
    const first = await listTimeline(db, parseTimelineFilters({}));
    const second = await listTimeline(db, parseTimelineFilters({ page: "2" }));
    expect([first.items.length, first.hasMore, second.items.length, second.hasMore]).toEqual([25, true, 2, false]);
  });

  it("puts Large entries of the last 14 days on top, and keeps their order otherwise", async () => {
    const day = 24 * 60 * 60 * 1000;
    await createNote(db, seed.actors.ada, updateInput({ title: "Old and large", impact: "large" }), new Date(Date.now() - 20 * day));
    await createNote(db, seed.actors.ada, updateInput({ title: "Recent and large", impact: "large" }), new Date(Date.now() - 3 * day));
    await createNote(db, seed.actors.ada, updateInput({ title: "Newest and small" }), new Date(Date.now() - day));
    // Imported entries may have no impact; they are never pinned.
    const unset = await createNote(db, seed.actors.ada, updateInput({ title: "Recent without impact" }), new Date(Date.now() - 2 * day));
    await db.update(entry).set({ impact: null }).where(eq(entry.id, unset.id));
    // A replaced decision is no longer in force.
    const replaced = await logDecision(db, seed.actors.ada, recordInput({ title: "Replaced and large", impact: "large", decidedOn: "2025-01-01" }), new Date(Date.now() - 4 * day));
    await logDecision(db, seed.actors.ada, recordInput({ title: "Replacement", impact: "small", decidedOn: "2025-01-01", supersedesId: replaced.id }), new Date(Date.now() - 5 * day));
    // A decision counts from when it was decided, e.g. a proposal submitted long before.
    const decidedLate = await logDecision(db, seed.actors.ada, recordInput({ title: "Decided late", impact: "large", decidedOn: "2025-01-01" }), new Date(Date.now() - 30 * day));
    await db.update(outcome).set({ createdAt: new Date(Date.now() - 6 * day) }).where(eq(outcome.entryId, decidedLate.id));
    const timeline = await listTimeline(db, parseTimelineFilters({}));
    expect(timeline.items.map((item) => [item.title, item.pinned])).toEqual([
      ["Recent and large", true],
      ["Decided late", true],
      ["Newest and small", false],
      ["Recent without impact", false],
      ["Replaced and large", false],
      ["Replacement", false],
      ["Old and large", false],
    ]);
  });

  it("offers only decisions that are not replaced yet for Supersedes", async () => {
    const { record } = await publishSample();
    const options = await searchEntriesForPicker(db, { q: "", supersedable: true });
    expect(options.map((o) => o.id)).toEqual([record.id]);
  });
});

describe("tags", () => {
  it("are managed by admins, renamed, and deactivated, never deleted", async () => {
    const created = await createTag(db, seed.actors.amy, { name: "Hiring" });
    await expectEntryError(createTag(db, seed.actors.amy, { name: "hiring" }), "invalid", "name");
    await expectEntryError(createTag(db, seed.actors.ada, { name: "Other" }), "forbidden");
    await renameTag(db, seed.actors.amy, created!.id, { name: "Recruiting" });
    await setTagActive(db, seed.actors.amy, created!.id, false);
    const events = await db.select({ action: auditEvent.action }).from(auditEvent).orderBy(auditEvent.createdAt);
    expect(events.map((e) => e.action)).toEqual(["tag.created", "tag.renamed", "tag.deactivated"]);
  });
});

describe("no deletion", () => {
  it("refuses to delete published entries, people, outcomes, and audit events, and to change the audit log", async () => {
    const record = await logDecision(db, seed.actors.ada, recordInput());
    const attempts = [
      db.delete(entry).where(eq(entry.id, record.id)),
      db.delete(person).where(eq(person.id, seed.people.lea.id)),
      db.delete(outcome).where(eq(outcome.entryId, record.id)),
      db.delete(participant).where(eq(participant.entryId, record.id)),
      db.delete(auditEvent),
      db.update(auditEvent).set({ action: "entry.edited" }),
    ];
    for (const attempt of attempts) {
      const error = await attempt.then(
        () => undefined,
        (caught: unknown) => caught as Error & { cause?: Error & { code?: string } },
      );
      // Drizzle wraps the PostgreSQL error raised by the trigger.
      expect(error?.cause?.code).toBe("23001");
      expect(error?.cause?.message).toMatch(/never deletes|Only unsubmitted drafts|append-only/);
    }
  });

  it("allows deleting an unsubmitted draft", async () => {
    const [draft] = await db
      .insert(entry)
      .values({ type: "decision", status: "draft", title: "Draft", summary: "", teamId: seed.teams.tech.id, authorId: seed.people.ada.id })
      .returning();
    await db.delete(entry).where(eq(entry.id, draft!.id));
    expect(await db.select().from(entry)).toHaveLength(0);
  });

  it("keeps tags on entries when an update is edited, through the revision snapshots", async () => {
    const created = await createNote(db, seed.actors.ada, updateInput());
    await editNote(db, seed.actors.ada, created.id, updateInput({ tagIds: [] }));
    expect(await db.select().from(entryTag)).toHaveLength(0);
    const history = await getEntryHistory(db, created.id);
    expect(history.revisions[0]?.tagNames).toEqual(["Budget"]);
  });
});

describe("rate limit", () => {
  it("allows 30 writes per person in 10 minutes", async () => {
    const now = new Date("2026-11-04T10:00:00Z");
    for (let i = 0; i < 30; i += 1) await consumeRateLimit(db, "write:ada", { limit: 30, windowSeconds: 600 }, now);
    await expect(consumeRateLimit(db, "write:ada", { limit: 30, windowSeconds: 600 }, now)).rejects.toBeInstanceOf(RateLimitError);
    await expect(consumeRateLimit(db, "write:dan", { limit: 30, windowSeconds: 600 }, now)).resolves.toBeUndefined();
    await expect(
      consumeRateLimit(db, "write:ada", { limit: 30, windowSeconds: 600 }, new Date("2026-11-04T10:10:00Z")),
    ).resolves.toBeUndefined();
  });
});

// Keeps the generated search column honest: it must cover the title with
// English stemming and, for any other language, word by word.
describe("search vector", () => {
  it("is generated by the database", async () => {
    await createNote(db, seed.actors.ada, updateInput({ title: "Entscheidungen planning", summary: "x", body: "" }));
    const [row] = await db.execute<{ simple: boolean; english: boolean }>(
      sql`select search_vector @@ to_tsquery('simple', 'entscheidungen') as simple, search_vector @@ to_tsquery('english', 'plans') as english from entry`,
    ).then((result) => result.rows);
    expect(row).toEqual({ simple: true, english: true });
  });
});
