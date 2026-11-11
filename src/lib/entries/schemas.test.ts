import { describe, expect, it } from "vitest";
import { decisionInputSchema, fieldErrorsOf, formDataToObject, logInputSchema, noteInputSchema } from "./schemas";

const TEAM = "0b8c8f5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const PERSON = "1c9d8f5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

function form(overrides: Record<string, string | string[]> = {}) {
  const data = new FormData();
  const values: Record<string, string | string[]> = {
    type: "update",
    title: "  New checklist  ",
    teamId: TEAM,
    summary: "One checklist for everyone.",
    impact: "small",
    personalDataConfirmed: "on",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return formDataToObject(data);
}

const decisionForm = (overrides: Record<string, string | string[]> = {}) =>
  form({
    type: "decision",
    decisionText: "We use one checklist.",
    rationale: "Fewer mistakes.",
    reversibility: "two_way",
    howDecided: "role_decision",
    deciderId: PERSON,
    decidedOn: "2026-11-02",
    ...overrides,
  });

describe("noteInputSchema", () => {
  it("accepts a minimal update and trims text", () => {
    const parsed = noteInputSchema.parse(form());
    expect(parsed).toMatchObject({
      type: "update",
      title: "New checklist",
      body: "",
      rationale: "",
      impact: "small",
      links: [],
      tagIds: [],
      affectedTeamIds: [],
      relatedIds: [],
    });
  });

  it("accepts a learning with an optional rationale", () => {
    expect(noteInputSchema.parse(form({ type: "learning", rationale: "  Retro  " }))).toMatchObject({ type: "learning", rationale: "Retro" });
  });

  it("requires the impact and the personal data confirmation", () => {
    const result = noteInputSchema.safeParse(form({ impact: [], personalDataConfirmed: [] }));
    const errors = fieldErrorsOf(result.error!);
    expect(errors.impact).toBe("Choose the impact.");
    expect(errors.personalDataConfirmed).toBe("Confirm that the entry contains no personal data.");
  });

  it("enforces the title and summary limits", () => {
    const result = noteInputSchema.safeParse(form({ title: "x".repeat(121), summary: "y".repeat(281) }));
    const errors = fieldErrorsOf(result.error!);
    expect(errors.title).toMatch(/at most 120/);
    expect(errors.summary).toMatch(/at most 280/);
  });

  it("drops empty and duplicate links and rejects non-http URLs", () => {
    expect(noteInputSchema.parse(form({ links: ["", "https://a.example", "https://a.example"] })).links).toEqual(["https://a.example"]);
    const result = noteInputSchema.safeParse(form({ links: ["javascript:alert(1)"] }));
    expect(fieldErrorsOf(result.error!).links).toMatch(/http/);
  });

  it("keeps each tag and affected team once", () => {
    const parsed = noteInputSchema.parse(form({ tagIds: [TEAM, TEAM], affectedTeamIds: [TEAM, TEAM] }));
    expect(parsed.tagIds).toEqual([TEAM]);
    expect(parsed.affectedTeamIds).toEqual([TEAM]);
  });

  it("does not accept a decision", () => {
    expect(fieldErrorsOf(noteInputSchema.safeParse(form({ type: "decision" })).error!).type).toBe("Choose a type.");
  });
});

describe("decisionInputSchema", () => {
  it("treats an empty Supersedes as none and requires the decision fields", () => {
    const result = decisionInputSchema.safeParse(form({ type: "decision", supersedesId: "" }));
    const errors = fieldErrorsOf(result.error!);
    expect(Object.keys(errors).sort()).toEqual(["decidedOn", "deciderId", "decisionText", "howDecided", "rationale", "reversibility"]);
  });

  it("accepts a two-way decision without a reason, and optional dates", () => {
    const parsed = decisionInputSchema.parse(decisionForm({ effectiveDate: "", reviewDate: "2027-05-01" }));
    expect(parsed).toMatchObject({ reversibility: "two_way", reversibilityReason: "", effectiveDate: undefined, reviewDate: "2027-05-01" });
  });

  it("requires a reason for a one-way decision", () => {
    const result = decisionInputSchema.safeParse(decisionForm({ reversibility: "one_way" }));
    expect(fieldErrorsOf(result.error!).reversibilityReason).toBe("Explain why the decision is hard to reverse.");
    expect(decisionInputSchema.safeParse(decisionForm({ reversibility: "one_way", reversibilityReason: "Contract" })).success).toBe(true);
    // Together with other errors, so the form shows them all at once.
    const both = fieldErrorsOf(decisionInputSchema.safeParse(decisionForm({ reversibility: "one_way", title: "" })).error!);
    expect(both).toMatchObject({ title: "Title is required.", reversibilityReason: "Explain why the decision is hard to reverse." });
  });
});

describe("logInputSchema", () => {
  it("reads the fields of the chosen type", () => {
    expect(logInputSchema.parse(form({ type: "learning" })).type).toBe("learning");
    const decision = logInputSchema.parse(decisionForm());
    expect(decision.type === "decision" && decision.decisionText).toBe("We use one checklist.");
  });

  it("asks for a type when none or an unknown one is chosen", () => {
    expect(fieldErrorsOf(logInputSchema.safeParse(form({ type: [] })).error!).type).toBe("Choose a type.");
    expect(fieldErrorsOf(logInputSchema.safeParse(form({ type: "proposal" })).error!).type).toBe("Choose a type.");
  });
});
