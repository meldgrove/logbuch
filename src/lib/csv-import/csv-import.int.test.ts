import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import {
  auditEvent,
  decision,
  entry,
  entryAffectedTeam,
  entryImport,
  entryRelation,
  entryTag,
  webhookState,
  notificationDelivery,
  outcome,
  person,
} from "@/lib/db/schema";
import { createNote } from "@/lib/entries/commands";
import { listTimeline } from "@/lib/entries/queries";
import { ImportError, importedPublishedAt, runCsvImport } from "./run";

const testDb = connectTestDatabase();
const { db } = testDb;
let seed: Awaited<ReturnType<typeof seedDirectory>>;
const NOW = new Date("2026-11-05T09:00:00Z");

beforeEach(async () => {
  await testDb.reset();
  seed = await seedDirectory(db);
  for (const [p, email] of [
    [seed.people.ada, "ada@example.org"],
    [seed.people.dan, "dan@example.org"],
    [seed.people.amy, "amy@example.org"],
  ] as const) {
    await db.update(person).set({ workEmail: email }).where(eq(person.id, p.id));
  }
});
afterAll(() => testDb.close());

const CSV = [
  "id,title,decided_on,decider_email,decision_text,involved_emails,how_decided,impact,reversibility",
  'OLD-1,Lead stages,2024-04-30,dan@example.org,"We use three lead stages.",ada@example.org,role_decision,Large,one-way',
  "OLD-2,Press contacts,30.04.2024,gone@example.org,,,integrative_meeting,,",
].join("\n");
const options = { teamName: "Engineering", asEmail: "amy@example.org", skip: [] as string[], now: NOW };

describe("the CSV import", () => {
  it("writes nothing in a dry run, prints each record in full, and a review fingerprint", async () => {
    const report = await runCsvImport(db, CSV, options);
    expect(report).toMatchObject({ wouldCreate: 1, problems: 1, created: 0, fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(await db.select().from(entry)).toHaveLength(0);
    const text = report.lines.join("\n");
    expect(text).toContain("Dry run. Nothing is written.");
    expect(text).toContain("Decided on 30.04.2024 by Dan Decider; Role decision; team Engineering.");
    expect(text).toContain("Impact: Large; reversibility: One-way.");
    expect(text).toContain("    We use three lead stages.");
    expect(text).toContain("Not imported: gone@example.org has no Logbuch access.");
    expect(text).toContain(`--confirm-no-personal-data ${report.fingerprint}`);
  });

  it("creates exactly the reviewed records once, through the normal command, without a channel post", async () => {
    const withFallback = { ...options, fallbackDeciderEmail: "ada@example.org" };
    const { fingerprint } = await runCsvImport(db, CSV, withFallback);
    const first = await runCsvImport(db, CSV, { ...withFallback, confirmFingerprint: fingerprint });
    expect(first).toMatchObject({ created: 2, problems: 0 });
    const records = await db.select().from(entry).orderBy(entry.number);
    expect(records.map((r) => [r.type, r.status, r.title, r.authorId, r.impact])).toEqual([
      ["decision", "published", "Lead stages", seed.people.amy.id, "large"],
      ["decision", "published", "Press contacts", seed.people.amy.id, null],
    ]);
    expect((await db.select().from(outcome)).map((o) => [o.decidedById, o.decidedOn])).toEqual([
      [seed.people.dan.id, "2024-04-30"],
      [seed.people.ada.id, "2024-04-30"],
    ]);
    // An old one-way decision is imported without a reason; the old name of the integrative process still works.
    expect((await db.select().from(decision)).map((d) => [d.deciderId, d.howDecided, d.reversibility, d.reversibilityReason])).toEqual([
      [seed.people.dan.id, "role_decision", "one_way", null],
      [seed.people.ada.id, "integrative_process", null, null],
    ]);
    expect(await db.select().from(auditEvent).where(eq(auditEvent.action, "entry.published"))).toHaveLength(2);
    expect(await db.select().from(webhookState)).toHaveLength(2);
    expect((await db.select().from(entryImport)).map((i) => [i.source, i.externalId])).toEqual([
      ["csv", "OLD-1"],
      ["csv", "OLD-2"],
    ]);
    expect((await db.select().from(notificationDelivery)).filter((d) => d.channel === "slack_channel")).toHaveLength(0);

    // A longer file later: only the new row is created.
    const longer = `${CSV}\nOLD-3,Desk sharing,2024-06-01,dan@example.org,,,`;
    const next = await runCsvImport(db, longer, withFallback);
    expect(next).toMatchObject({ wouldCreate: 1, alreadyImported: 2 });
  });

  it("refuses a confirmation for records other than the reviewed ones", async () => {
    const { fingerprint } = await runCsvImport(db, CSV, options);
    const changed = CSV.replace("We use three lead stages.", "Changed after the review.");
    await expect(runCsvImport(db, changed, { ...options, confirmFingerprint: fingerprint })).rejects.toThrow(/differ from the reviewed dry run/);
    expect(await db.select().from(entry)).toHaveLength(0);
  });

  it("leaves out rows passed with --skip, and reports duplicate ids", async () => {
    const duplicated = `${CSV}\nOLD-1,Again,2024-04-30,dan@example.org,,,`;
    const report = await runCsvImport(db, duplicated, { ...options, skip: ["OLD-2"] });
    expect(report).toMatchObject({ wouldCreate: 1, skipped: 1, problems: 1 });
    expect(report.lines.join("\n")).toContain("The id OLD-1 appears more than once in the file.");
  });

  it("reports a future date in the dry run instead of failing the import", async () => {
    const future = `${CSV}\nOLD-9,Later,2099-01-01,dan@example.org,,,`;
    const report = await runCsvImport(db, future, options);
    expect(report.lines.join("\n")).toContain("Not imported: decided_on 2099-01-01 lies in the future.");
    const confirmed = await runCsvImport(db, future, { ...options, confirmFingerprint: report.fingerprint });
    expect(confirmed.created).toBe(1);
    expect(confirmed.failed).toBeUndefined();
  });

  it("imports updates and decisions with their original date, details, tags, and related rows", async () => {
    const csv = [
      "id,type,title,date,summary,details,impact,tags,related,affected_teams,decider_email,reversibility,why_one_way",
      "D-1,decision,Password manager,2024-01-12,,We tested two tools.,large,Tools,,Operations,dan@example.org,one_way,All credentials move.",
      'U-1,update,Single sign-on,24.07.2026,One sign-in for our tools.,"Sign in at login.example.org.",large,"Budget, Tools",D-1,,,,',
    ].join("\n");
    const { fingerprint, wouldCreate, lines } = await runCsvImport(db, csv, options);
    expect(wouldCreate).toBe(2);
    expect(lines.join("\n")).toContain("Update of 24.07.2026; team Engineering.");
    expect(lines.join("\n")).toContain("Why one-way: All credentials move.");
    expect(await runCsvImport(db, csv, { ...options, confirmFingerprint: fingerprint })).toMatchObject({ created: 2, problems: 0 });

    const [d1, u1] = await db.select().from(entry).orderBy(entry.number);
    // Noon in Amsterdam on the original day (CET in January, CEST in July); the record itself is from now.
    expect([d1!.type, d1!.publishedAt, d1!.submittedAt, d1!.createdAt, d1!.body]).toEqual([
      "decision",
      new Date("2024-01-12T11:00:00Z"),
      new Date("2024-01-12T11:00:00Z"),
      NOW,
      "We tested two tools.",
    ]);
    expect([u1!.type, u1!.publishedAt, u1!.createdAt, u1!.summary, u1!.body]).toEqual([
      "update",
      new Date("2026-07-24T10:00:00Z"),
      NOW,
      "One sign-in for our tools.",
      "Sign in at login.example.org.",
    ]);
    expect((await db.select().from(outcome)).map((o) => o.createdAt)).toEqual([new Date("2024-01-12T11:00:00Z")]);
    expect((await db.select().from(decision)).map((d) => [d.reversibility, d.reversibilityReason])).toEqual([["one_way", "All credentials move."]]);
    expect(await db.select({ entryId: entryRelation.entryId, relatedEntryId: entryRelation.relatedEntryId }).from(entryRelation)).toEqual([
      { entryId: u1!.id, relatedEntryId: d1!.id },
    ]);
    expect(await db.select({ entryId: entryAffectedTeam.entryId, teamId: entryAffectedTeam.teamId }).from(entryAffectedTeam)).toEqual([
      { entryId: d1!.id, teamId: seed.teams.ops.id },
    ]);
    expect((await db.select().from(entryTag)).filter((t) => t.entryId === u1!.id).map((t) => t.tagId).sort()).toEqual(
      [seed.tags.budget.id, seed.tags.tools.id].sort(),
    );
    expect((await db.select().from(notificationDelivery)).filter((d) => d.channel === "slack_channel")).toHaveLength(0);
    expect((await db.select().from(entryImport)).map((i) => i.externalId)).toEqual(["D-1", "U-1"]);

    // Old Large entries are neither pinned nor new: a fresh small update comes first.
    await createNote(db, seed.actors.ada, {
      type: "update",
      title: "Fresh",
      summary: "Just now.",
      body: "",
      rationale: "",
      impact: "small",
      teamId: seed.teams.tech.id,
      affectedTeamIds: [],
      tagIds: [],
      links: [],
      relatedIds: [],
      personalDataConfirmed: "on",
    });
    const { items } = await listTimeline(db, {});
    expect(items.map((i) => [i.title, i.pinned, i.imported])).toEqual([
      ["Fresh", false, false],
      ["Single sign-on", false, true],
      ["Password manager", false, true],
    ]);

    // A later file may relate to entries imported before.
    const later = await runCsvImport(db, "id,type,title,date,related\nU-2,learning,Retro,2026-08-01,U-1 D-1", options);
    expect(later).toMatchObject({ wouldCreate: 1, problems: 0 });
  });

  it("relates only to rows above or to imported entries", async () => {
    const csv = ["id,type,title,date,related", "U-1,update,First,2024-01-01,", "U-2,update,Second,2024-01-02,U-3", "U-3,update,Third,2024-01-03,U-9"].join(
      "\n",
    );
    const report = await runCsvImport(db, csv, options);
    expect(report).toMatchObject({ wouldCreate: 1, problems: 2 });
    const text = report.lines.join("\n");
    expect(text).toContain("Not imported: related U-3: not an imported entry or an importable row above this one.");
    expect(text).toContain("Not imported: related U-9: not an imported entry or an importable row above this one.");
  });

  it("takes noon in the server's time zone as the publication time, but never a time after now", () => {
    expect(importedPublishedAt("2026-03-29", NOW)).toEqual(new Date("2026-03-29T10:00:00Z"));
    expect(importedPublishedAt("2026-11-05", NOW)).toEqual(NOW);
  });

  it("needs the id, title, and decided_on columns, an admin, and an active team", async () => {
    await expect(runCsvImport(db, "title,decided_on\nA,2024-01-01", options)).rejects.toThrow(/no column id/);
    await expect(runCsvImport(db, CSV, { ...options, asEmail: "ada@example.org" })).rejects.toThrow(ImportError);
    await expect(runCsvImport(db, CSV, { ...options, teamName: "Archive" })).rejects.toThrow(/No active team/);
  });
});
