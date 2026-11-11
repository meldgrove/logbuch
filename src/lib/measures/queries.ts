import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { appSetting, decision, entry, entryImport, outcome, person, personActiveMonth, proposal } from "@/lib/db/schema";
import { serverDate } from "@/lib/format";
import { ACTIVITY_SINCE_KEY } from "./activity";
import { recentMonths, summarizeMeasures, type Measures } from "./summary";

/** The statistics for the last `months` months, newest first. */
export async function getMonthlyStatistics(db: Database, now: Date = new Date(), months = 6): Promise<Measures> {
  const [proposals, published, active, [withAccess], [since]] = await Promise.all([
    db
      .select({
        submittedAt: entry.submittedAt,
        status: entry.status,
        reversibility: decision.reversibility,
        decidedOn: outcome.decidedOn,
      })
      .from(entry)
      .innerJoin(proposal, eq(proposal.entryId, entry.id))
      .innerJoin(decision, eq(decision.entryId, entry.id))
      .leftJoin(outcome, eq(outcome.entryId, entry.id))
      .where(isNotNull(entry.submittedAt)),
    db
      .select({ type: entry.type, publishedAt: entry.publishedAt })
      .from(entry)
      // Imported old decisions are not use of Logbuch.
      .leftJoin(entryImport, eq(entryImport.entryId, entry.id))
      // Logged entries are "published"; proposals end as decided or rejected.
      .where(and(eq(entry.status, "published"), isNotNull(entry.publishedAt), isNull(entryImport.entryId))),
    db.select({ month: personActiveMonth.month, value: count() }).from(personActiveMonth).groupBy(personActiveMonth.month),
    db.select({ value: count() }).from(person).where(eq(person.hasAccess, true)),
    db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, ACTIVITY_SINCE_KEY)),
  ]);
  return summarizeMeasures({
    proposals: proposals.map((p) => ({
      submittedOn: serverDate(p.submittedAt!),
      status: p.status,
      // Proposals always have a reversibility.
      reversibility: p.reversibility ?? "two_way",
      decidedOn: p.decidedOn,
    })),
    published: published.map((e) => ({ type: e.type, publishedOn: serverDate(e.publishedAt!) })),
    activeByMonth: new Map(active.map((a) => [a.month.slice(0, 7), a.value])),
    peopleWithAccess: withAccess?.value ?? 0,
    months: recentMonths(serverDate(now), months),
    trackingSince: typeof since?.value === "string" ? serverDate(new Date(since.value)) : null,
  });
}
