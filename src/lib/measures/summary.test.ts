import { describe, expect, it } from "vitest";
import { median, recentMonths, summarizeMeasures, type ProposalFacts } from "./summary";

const proposal = (overrides: Partial<ProposalFacts>): ProposalFacts => ({
  submittedOn: "2026-11-02",
  status: "feedback",
  reversibility: "two_way",
  decidedOn: null,
  ...overrides,
});

describe("monthly statistics", () => {
  it("take the median of an odd and an even number of values", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("list the recent months, newest first, across a year boundary", () => {
    expect(recentMonths("2027-02-15", 4)).toEqual(["2027-02", "2027-01", "2026-12", "2026-11"]);
  });

  it("count proposals by month of submission, and those finished by now", () => {
    const { months, total } = summarizeMeasures({
      proposals: [
        proposal({ status: "decided", decidedOn: "2026-11-06" }),
        proposal({ status: "withdrawn" }),
        proposal({ status: "objection_round" }),
        proposal({ submittedOn: "2026-10-30", status: "rejected", decidedOn: "2026-11-03" }),
      ],
      activeByMonth: new Map(),
      peopleWithAccess: 10,
      months: ["2026-11", "2026-10"],
    });
    expect(months.map((m) => [m.month, m.started, m.startedFinished])).toEqual([
      ["2026-11", 3, 2],
      ["2026-10", 1, 1],
    ]);
    expect(total).toEqual({ started: 4, finished: 3 });
  });

  it("measure working days from submission to decision, by decision type and month of the decision", () => {
    const { months } = summarizeMeasures({
      proposals: [
        // Friday to the next Wednesday: 3 working days.
        proposal({ submittedOn: "2026-10-30", status: "decided", decidedOn: "2026-11-04" }),
        proposal({ submittedOn: "2026-11-02", status: "rejected", decidedOn: "2026-11-03" }),
        proposal({ submittedOn: "2026-11-02", status: "decided", decidedOn: "2026-11-16", reversibility: "one_way" }),
        // Withdrawn proposals are not decisions.
        proposal({ submittedOn: "2026-11-02", status: "withdrawn", decidedOn: "2026-11-20" }),
      ],
      activeByMonth: new Map([["2026-11", 7]]),
      peopleWithAccess: 10,
      months: ["2026-11"],
    });
    expect(months[0]).toMatchObject({
      medianWorkingDays: { two_way: 2, one_way: 10 },
      decisions: { two_way: 2, one_way: 1 },
      activePeople: 7,
    });
  });

  it("show months before activity was recorded as not recorded, and the first month as partial", () => {
    const { months } = summarizeMeasures({
      proposals: [],
      activeByMonth: new Map([["2026-11", 4]]),
      peopleWithAccess: 10,
      months: ["2026-12", "2026-11", "2026-10"],
      trackingSince: "2026-11-04",
    });
    expect(months.map((m) => [m.month, m.activePeople, m.activeFrom])).toEqual([
      ["2026-12", 0, null],
      ["2026-11", 4, "2026-11-04"],
      ["2026-10", null, null],
    ]);
  });

  it("count updates, learnings, and logged decisions by the month they were published", () => {
    const { months } = summarizeMeasures({
      proposals: [],
      published: [
        { type: "update", publishedOn: "2026-11-02" },
        { type: "update", publishedOn: "2026-11-30" },
        { type: "learning", publishedOn: "2026-11-15" },
        { type: "decision", publishedOn: "2026-10-31" },
      ],
      activeByMonth: new Map(),
      peopleWithAccess: 1,
      months: ["2026-11", "2026-10"],
    });
    expect(months.map((m) => [m.month, m.published])).toEqual([
      ["2026-11", { updates: 2, learnings: 1, decisions: 0 }],
      ["2026-10", { updates: 0, learnings: 0, decisions: 1 }],
    ]);
  });
});
