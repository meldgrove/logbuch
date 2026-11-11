import { describe, expect, it } from "vitest";
import { toWebhookPayload, type EntryFacts } from "./payload";
import { payloadHash } from "./sync";

const BASE_URL = "https://logbuch.example/";
const PUBLISHED_AT = new Date("2026-11-04T09:00:00Z");
const DECIDED_AT = new Date("2026-11-06T15:00:00Z");

function facts(overrides: { entry?: Partial<EntryFacts["entry"]> } & Partial<Omit<EntryFacts, "entry">> = {}): EntryFacts {
  const { entry, ...rest } = overrides;
  return {
    entry: {
      id: "e1",
      number: 12,
      type: "update",
      status: "published",
      title: "New on-call rota",
      summary: "Weekly rotation.",
      body: "Details.",
      rationale: "",
      impact: "medium",
      publishedAt: PUBLISHED_AT,
      supersedesNumber: null,
      supersededByNumber: null,
      ...entry,
    },
    teamName: "Ops",
    authorName: "Ada Author",
    affectedTeamNames: ["Engineering"],
    tagNames: ["on-call"],
    decision: null,
    proposal: null,
    outcome: null,
    involvedNames: [],
    addenda: [],
    openObjections: [],
    ...rest,
  };
}

const decision = { reversibility: "two_way" as const, howDecided: "integrative_process" as const, deciderName: "Dan Decider" };
const outcome = (result: NonNullable<EntryFacts["outcome"]>["result"]) => ({
  result,
  finalText: result === "rejected" ? "" : "We rotate weekly.",
  objectionHandling: null,
  decidedOn: "2026-11-06",
  decidedAt: DECIDED_AT,
  decidedByName: "Dan Decider",
});
const proposal = { currentVersion: 2, consentGiverNames: [] };

/** A logged decision. */
const logged = (overrides: Parameters<typeof facts>[0] = {}) =>
  facts({ ...overrides, entry: { type: "decision", ...overrides.entry }, decision, outcome: outcome("recorded") });
/** A decision that went through the decision process. */
const proposed = (status: string, result: NonNullable<EntryFacts["outcome"]>["result"] | null) =>
  facts({ entry: { type: "decision", status }, decision, proposal, outcome: result ? outcome(result) : null });

describe("which entries are sent", () => {
  const cases: [string, EntryFacts, boolean][] = [
    ["a published update", facts(), true],
    ["a published learning", facts({ entry: { type: "learning" } }), true],
    ["a logged decision", logged(), true],
    ["a logged decision without its outcome", facts({ entry: { type: "decision" }, decision }), false],
    ["a draft", facts({ entry: { status: "draft" } }), false],
    ["a proposal in feedback", proposed("feedback", null), false],
    ["a proposal in the objection round", proposed("objection_round", null), false],
    ["a decided proposal", proposed("decided", "adopted"), true],
    ["a rejected proposal", proposed("rejected", "rejected"), true],
    ["a withdrawn proposal", proposed("withdrawn", "withdrawn"), false],
  ];
  it.each(cases)("%s: %s", (_, entryFacts, sent) => {
    expect(toWebhookPayload(entryFacts, BASE_URL) !== null).toBe(sent);
  });
});

describe("the payload", () => {
  it("carries an update as it is now, with a link and without a decision", () => {
    expect(toWebhookPayload(facts(), BASE_URL)).toEqual({
      event: "entry.changed",
      entry: {
        id: "e1",
        ref: "LB-12",
        url: "https://logbuch.example/e/LB-12",
        type: "update",
        status: "published",
        title: "New on-call rota",
        summary: "Weekly rotation.",
        details: "Details.",
        rationale: "",
        impact: "medium",
        team: "Ops",
        affected_teams: ["Engineering"],
        tags: ["on-call"],
        author: "Ada Author",
        published_at: "2026-11-04T09:00:00.000Z",
        in_force: true,
        supersedes: null,
        superseded_by: null,
        decision: null,
        addenda: [],
      },
    });
  });

  it("describes a decided proposal with its version, consent givers, and open objections", () => {
    const payload = toWebhookPayload(
      facts({
        entry: { type: "decision", status: "decided", supersedesNumber: 3 },
        decision: { ...decision, reversibility: "one_way" },
        proposal: { currentVersion: 2, consentGiverNames: ["Amy Admin"] },
        outcome: { ...outcome("adopted"), objectionHandling: "Fridays stay covered." },
        openObjections: ["Customers need us on Fridays."],
      }),
      BASE_URL,
    );
    expect(payload?.entry).toMatchObject({ in_force: true, supersedes: "LB-3", superseded_by: null });
    expect(payload?.entry.decision).toEqual({
      result: "adopted",
      text: "We rotate weekly.",
      reversibility: "one_way",
      how_decided: "integrative_process",
      decider: "Dan Decider",
      decided_on: "2026-11-06",
      decided_at: "2026-11-06T15:00:00.000Z",
      objection_handling: "Fridays stay covered.",
      open_objections: ["Customers need us on Fridays."],
      consent_givers: ["Amy Admin"],
      involved: [],
      proposal_version: 2,
    });
  });

  it("marks a rejected proposal as not in force, without decision text", () => {
    const payload = toWebhookPayload(proposed("rejected", "rejected"), BASE_URL);
    expect(payload?.entry.in_force).toBe(false);
    expect(payload?.entry.decision).toMatchObject({ result: "rejected", text: "" });
  });

  it("marks a replaced decision as no longer in force, with the replacement", () => {
    const payload = toWebhookPayload(logged({ entry: { supersededByNumber: 20 } }), BASE_URL);
    expect(payload?.entry).toMatchObject({ in_force: false, superseded_by: "LB-20" });
    expect(payload?.entry.decision).toMatchObject({ result: "recorded", proposal_version: null, involved: [] });
  });

  it("lists addenda with their authors", () => {
    const addenda = [{ text: "Starts in December.", authorName: "Dan Decider", createdAt: DECIDED_AT }];
    expect(toWebhookPayload(logged({ addenda, involvedNames: ["Eve Expert"] }), BASE_URL)?.entry).toMatchObject({
      addenda: [{ text: "Starts in December.", author: "Dan Decider", created_at: "2026-11-06T15:00:00.000Z" }],
      decision: { involved: ["Eve Expert"] },
    });
  });
});

describe("the payload hash", () => {
  it("ignores key order and changes with the content", () => {
    const payload = toWebhookPayload(facts(), BASE_URL)!;
    const reordered = { entry: { ...payload.entry }, event: payload.event };
    expect(payloadHash(reordered)).toBe(payloadHash(payload));
    expect(payloadHash({ ...payload, entry: { ...payload.entry, title: "Changed" } })).not.toBe(payloadHash(payload));
  });
});
