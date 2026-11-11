import { describe, expect, it } from "vitest";
import { textDiff } from "./diff";
import { parseTimelineFilters } from "./queries";
import { entryPath, formatEntryRef, parseEntryRef } from "./refs";

describe("entry references", () => {
  it("formats and parses LB numbers", () => {
    expect(formatEntryRef(12)).toBe("LB-12");
    expect(entryPath(12)).toBe("/e/LB-12");
    for (const value of ["LB-12", "lb12", " 12 "]) expect(parseEntryRef(value)).toBe(12);
    for (const value of ["LB-", "LB-0", "abc", "LB-1x"]) expect(parseEntryRef(value)).toBeUndefined();
  });
});

describe("parseTimelineFilters", () => {
  it("ignores invalid values instead of failing", () => {
    expect(
      parseTimelineFilters({
        type: "letter",
        status: "lost",
        impact: "huge",
        reversibility: "three_way",
        how: "vote",
        team: "not-a-uuid",
        affected: "x",
        from: "2026-13-40",
        page: "0",
        q: "  budget  ",
      }),
    ).toEqual({
      q: "budget",
      type: undefined,
      status: undefined,
      impact: undefined,
      reversibility: undefined,
      how: undefined,
      team: undefined,
      affected: undefined,
      tag: undefined,
      person: undefined,
      from: undefined,
      to: undefined,
      page: undefined,
    });
    expect(parseTimelineFilters({ type: "learning", impact: "large", how: "role_decision", page: "2", from: "2026-11-01" })).toMatchObject({
      type: "learning",
      impact: "large",
      how: "role_decision",
      page: 2,
      from: "2026-11-01",
    });
  });
});

describe("textDiff", () => {
  it("marks added and removed words", () => {
    const parts = textDiff("one checklist for every colleague", "one checklist for everyone");
    expect(parts.filter((p) => p.removed).map((p) => p.value.trim())).toContain("every colleague");
    expect(parts.filter((p) => p.added).map((p) => p.value.trim())).toContain("everyone");
  });
});
