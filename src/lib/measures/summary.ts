import { workingDaysBetween } from "@/lib/calendar";

/*
 * Usage statistics by month, in the server's time zone:
 * proposals started, how many of them are finished, median working days from
 * submission to decision, and people who opened Logbuch.
 */

export interface ProposalFacts {
  /** Date of submission. */
  submittedOn: string;
  status: string;
  reversibility: "two_way" | "one_way";
  /** Date of the outcome, for decided and rejected proposals. */
  decidedOn: string | null;
}

export interface MonthMeasures {
  /** "2026-11" */
  month: string;
  started: number;
  /** Of the proposals started this month, those decided, rejected, or withdrawn by now. */
  startedFinished: number;
  /** Median working days from submission to decision, for decisions made this month. */
  medianWorkingDays: { two_way: number | null; one_way: number | null };
  decisions: { two_way: number; one_way: number };
  /** Updates, learnings, and decisions logged directly, published this month. */
  published: { updates: number; learnings: number; decisions: number };
  /** People who opened Logbuch this month; null before activity was recorded. */
  activePeople: number | null;
  /** The day activity recording started, when that was during this month. */
  activeFrom: string | null;
}

export interface Measures {
  months: MonthMeasures[];
  total: { started: number; finished: number };
  peopleWithAccess: number;
}

const FINISHED = new Set(["decided", "rejected", "withdrawn"]);

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The `count` months up to and including the month of `today`, newest first. */
export function recentMonths(today: string, count: number): string[] {
  const [year, month] = today.split("-").map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(year, month - 1 - i, 1));
    return date.toISOString().slice(0, 7);
  });
}

export function summarizeMeasures(input: {
  proposals: ProposalFacts[];
  /** Dates on which updates, learnings, and logged decisions were published. */
  published?: { type: "update" | "learning" | "decision"; publishedOn: string }[];
  /** Active people by month ("2026-11"). */
  activeByMonth: Map<string, number>;
  peopleWithAccess: number;
  months: string[];
  /** Date from which activity is recorded; unknown means every month counts. */
  trackingSince?: string | null;
}): Measures {
  const since = input.trackingSince ?? null;
  const publishedIn = (month: string, type: "update" | "learning" | "decision") =>
    (input.published ?? []).filter((e) => e.type === type && e.publishedOn.startsWith(month)).length;
  const months = input.months.map((month): MonthMeasures => {
    const started = input.proposals.filter((p) => p.submittedOn.startsWith(month));
    const decided = input.proposals.filter((p) => p.decidedOn?.startsWith(month) && (p.status === "decided" || p.status === "rejected"));
    const days = (type: ProposalFacts["reversibility"]) =>
      decided.filter((p) => p.reversibility === type).map((p) => workingDaysBetween(p.submittedOn, p.decidedOn!));
    return {
      month,
      started: started.length,
      startedFinished: started.filter((p) => FINISHED.has(p.status)).length,
      medianWorkingDays: { two_way: median(days("two_way")), one_way: median(days("one_way")) },
      decisions: { two_way: days("two_way").length, one_way: days("one_way").length },
      published: {
        updates: publishedIn(month, "update"),
        learnings: publishedIn(month, "learning"),
        decisions: publishedIn(month, "decision"),
      },
      activePeople: since && month < since.slice(0, 7) ? null : (input.activeByMonth.get(month) ?? 0),
      activeFrom: since && since.slice(0, 7) === month && !since.endsWith("-01") ? since : null,
    };
  });
  return {
    months,
    total: { started: input.proposals.length, finished: input.proposals.filter((p) => FINISHED.has(p.status)).length },
    peopleWithAccess: input.peopleWithAccess,
  };
}
