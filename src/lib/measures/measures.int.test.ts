import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { appSetting, personActiveMonth } from "@/lib/db/schema";
import { logDecision } from "@/lib/entries/commands";
import { decisionInputSchema } from "@/lib/entries/schemas";
import { ACTIVITY_SINCE_KEY, recordActivity } from "./activity";
import { getMonthlyStatistics } from "./queries";

const testDb = connectTestDatabase();
const { db } = testDb;
let seed: Awaited<ReturnType<typeof seedDirectory>>;

beforeEach(async () => {
  await testDb.reset();
  seed = await seedDirectory(db);
});
afterAll(() => testDb.close());

describe("activity", () => {
  it("is recorded once per person and month, in the server's time zone", async () => {
    const { ada, dan } = seed.people;
    await recordActivity(db, ada.id, new Date("2026-10-31T23:30:00Z")); // 00:30 on November 1 in Amsterdam
    await recordActivity(db, ada.id, new Date("2026-11-20T09:00:00Z"));
    await recordActivity(db, dan.id, new Date("2026-10-31T22:30:00Z")); // 23:30 on October 31 in Amsterdam
    const rows = await db.select().from(personActiveMonth).orderBy(personActiveMonth.month);
    expect(rows.map((r) => [r.personId, r.month])).toEqual([
      [dan.id, "2026-10-01"],
      [ada.id, "2026-11-01"],
    ]);

    const measures = await getMonthlyStatistics(db, new Date("2026-11-20T09:00:00Z"), 2);
    expect(measures.months.map((m) => [m.month, m.activePeople])).toEqual([
      ["2026-11", 1],
      ["2026-10", 1],
    ]);
    expect(measures.peopleWithAccess).toBe(3);
  });

  it("never holds up a request when the table is locked", async () => {
    const blocker = await testDb.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("lock table person_active_month in access exclusive mode");
      const started = Date.now();
      await expect(recordActivity(db, seed.people.dan.id, new Date("2026-09-10T09:00:00Z"))).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await blocker.query("rollback");
      blocker.release();
    }
    // Not remembered as written, so the next request records it.
    await recordActivity(db, seed.people.dan.id, new Date("2026-09-10T09:00:00Z"));
    expect(await db.select().from(personActiveMonth)).toHaveLength(1);
  });

  it("starts with the deployment that added it; earlier months are not recorded", async () => {
    await db.insert(appSetting).values({ key: ACTIVITY_SINCE_KEY, value: "2026-11-04T09:30:00.000+00:00" });
    const measures = await getMonthlyStatistics(db, new Date("2026-11-20T09:00:00Z"), 2);
    expect(measures.months.map((m) => [m.month, m.activePeople, m.activeFrom])).toEqual([
      ["2026-11", 0, "2026-11-04"],
      ["2026-10", null, null],
    ]);
  });

  it("is never deleted", async () => {
    await recordActivity(db, seed.people.amy.id, new Date("2026-11-04T09:00:00Z"));
    await expect(db.delete(personActiveMonth)).rejects.toThrow();
  });

  it("does not count imported old decisions as decisions logged", async () => {
    const record = decisionInputSchema.parse({
      type: "decision",
      impact: "medium",
      reversibility: "two_way",
      title: "Record",
      teamId: seed.teams.tech.id,
      tagIds: [],
      summary: "s",
      links: [],
      decisionText: "d",
      rationale: "r",
      deciderId: seed.people.dan.id,
      involvedIds: [],
      howDecided: "other",
      decidedOn: "2024-04-30",
      personalDataConfirmed: "on",
    });
    const now = new Date("2026-11-20T09:00:00Z");
    await logDecision(db, seed.actors.amy, record, now, { announce: false, importedFrom: { source: "csv", externalId: "OLD-1" } });
    await logDecision(db, seed.actors.amy, record, now);
    const measures = await getMonthlyStatistics(db, now, 1);
    expect(measures.months[0]!.published).toEqual({ updates: 0, learnings: 0, decisions: 1 });
  });
});

