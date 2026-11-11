import { createHash } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { entry, entryImport, person, tag, team } from "@/lib/db/schema";
import { createNote, logDecision } from "@/lib/entries/commands";
import { HOW_DECIDED_LABELS, IMPACT_LABELS, NOT_SET, REVERSIBILITY_LABELS, TYPE_LABELS } from "@/lib/entries/constants";
import { defaultFormatter, serverDate, serverDateTime } from "@/lib/format";
import { parseCsvRecords } from "./csv";
import { COLUMNS, mapRow, type MappedEntry, type Person } from "./mapping";

export const IMPORT_SOURCE = "csv";

export interface ImportOptions {
  /** Team of rows without a `team` column value (an active team, by name). */
  teamName: string;
  /** Work email of the admin who runs the import; becomes the author. */
  asEmail: string;
  /** Work email of the decider when a row's decider has no Logbuch access. */
  fallbackDeciderEmail?: string;
  /** Row ids to leave out. */
  skip: string[];
  /**
   * The fingerprint the dry run printed. Only with it does the import write:
   * it records the personal data confirmation for exactly the records
   * that were reviewed. Without it, the run is a dry run.
   */
  confirmFingerprint?: string;
  now?: Date;
}

export interface ImportReport {
  lines: string[];
  /** Set when a confirmed import stopped at an unexpected error; records before it were created. */
  failed?: string;
  fingerprint: string;
  created: number;
  wouldCreate: number;
  alreadyImported: number;
  skipped: number;
  problems: number;
}

export class ImportError extends Error {}

type Create = { id: string; title: string; kind: "create" } & MappedEntry;
type Planned =
  | { id: string; title: string; kind: "skipped" }
  | { id: string; title: string; kind: "imported"; number: number }
  | { id: string; title: string; kind: "problem"; problem: string }
  | Create;

/** A short hash of what would be created, so a confirmation applies only to the reviewed records. */
function fingerprintOf(planned: Planned[]): string {
  const records = planned
    .filter((p): p is Create => p.kind === "create")
    .map((p) => ({ id: p.id, date: p.date, related: p.related, input: p.input }));
  return createHash("sha256").update(JSON.stringify(records)).digest("hex").slice(0, 12);
}

/**
 * When an imported entry counts as published: noon on its date in the
 * server's time zone, or now if that is later. The timeline sorts old entries
 * by it.
 */
export function importedPublishedAt(date: string, now: Date): Date {
  const noon = serverDateTime(date, 12);
  return noon < now ? noon : now;
}

/**
 * Imports old updates, learnings, and decisions from a CSV file. The dry run
 * prints every record in full for the personal data check and a fingerprint
 * of them; the import writes only with that
 * fingerprint, so it creates exactly what was reviewed. Each row `id` is
 * imported at most once (`entry_import`, unique), so the import can run again
 * with a longer file. Entries keep their original date.
 */
export async function runCsvImport(db: Database, csv: string, options: ImportOptions): Promise<ImportReport> {
  const now = options.now ?? new Date();
  const { columns, records } = parseCsvRecords(csv);
  const missing: string[] = ["id", "title"].filter((column) => !columns.includes(column));
  if (!columns.includes("date") && !columns.includes("decided_on")) missing.push("date");
  if (missing.length > 0) throw new ImportError(`The file has no column ${missing.join(", ")}. See docs/entry-import-template.csv.`);
  const unknown = columns.filter((column) => column !== "" && !(COLUMNS as readonly string[]).includes(column));

  const teams = await db.select({ id: team.id, name: team.name }).from(team).where(eq(team.isActive, true));
  const teamsByName = new Map(teams.map((t) => [t.name.toLowerCase(), t]));
  const defaultTeam = teamsByName.get(options.teamName.toLowerCase());
  if (!defaultTeam) throw new ImportError(`No active team named "${options.teamName}".`);
  const tags = await db.select({ id: tag.id, name: tag.name }).from(tag).where(eq(tag.isActive, true));
  const tagsByName = new Map(tags.map((t) => [t.name.toLowerCase(), t]));
  const withAccess = await db
    .select({ id: person.id, name: person.displayName, email: person.workEmail, isAdmin: person.isAdmin })
    .from(person)
    .where(and(eq(person.hasAccess, true), isNotNull(person.workEmail)));
  const byEmail = new Map(withAccess.map((p) => [p.email!.toLowerCase(), p]));
  const actor = byEmail.get(options.asEmail.toLowerCase());
  if (!actor?.isAdmin) throw new ImportError(`${options.asEmail} is not a Logbuch admin with access.`);
  let fallbackDecider: Person | undefined;
  if (options.fallbackDeciderEmail) {
    fallbackDecider = byEmail.get(options.fallbackDeciderEmail.toLowerCase());
    if (!fallbackDecider) throw new ImportError(`${options.fallbackDeciderEmail} has no Logbuch access.`);
  }
  const names = new Map(withAccess.map((p) => [p.id, p.name]));
  const skip = new Set(options.skip.map((id) => id.trim()));
  const importedEntries = async () =>
    new Map(
      (
        await db
          .select({ externalId: entryImport.externalId, entryId: entryImport.entryId, number: entry.number })
          .from(entryImport)
          .innerJoin(entry, eq(entry.id, entryImport.entryId))
          .where(eq(entryImport.source, IMPORT_SOURCE))
      ).map((row) => [row.externalId, row]),
    );
  const imported = await importedEntries();

  const seen = new Set<string>();
  /** Rows above that are in Logbuch, or will be: the rows a row may relate to. */
  const relatable = new Set(imported.keys());
  const planned: Planned[] = records.map((row, index): Planned => {
    const id = row.id ?? "";
    const title = row.title || `(row ${index + 2})`;
    if (!id) return { id: `row ${index + 2}`, title, kind: "problem", problem: "The id is empty." };
    if (seen.has(id)) return { id, title, kind: "problem", problem: `The id ${id} appears more than once in the file.` };
    seen.add(id);
    if (skip.has(id)) return { id, title, kind: "skipped" };
    const done = imported.get(id);
    if (done) return { id, title, kind: "imported", number: done.number };
    const mapped = mapRow(row, { today: serverDate(now), defaultTeam, teamsByName, tagsByName, peopleByEmail: byEmail, fallbackDecider });
    if (!mapped.ok) return { id, title, kind: "problem", problem: mapped.problem };
    const unrelatable = mapped.related.filter((relatedId) => !relatable.has(relatedId));
    if (unrelatable.length > 0) {
      return { id, title, kind: "problem", problem: `related ${unrelatable.join(", ")}: not an imported entry or an importable row above this one.` };
    }
    relatable.add(id);
    return { id, title, kind: "create", ...mapped };
  });
  const fingerprint = fingerprintOf(planned);
  const confirmed = options.confirmFingerprint !== undefined;
  if (confirmed && options.confirmFingerprint !== fingerprint) {
    throw new ImportError(
      `The records differ from the reviewed dry run (fingerprint ${fingerprint}, confirmed ${options.confirmFingerprint}). The file or the options changed: run the dry run again and review it.`,
    );
  }

  const report: ImportReport = { lines: [], fingerprint, created: 0, wouldCreate: 0, alreadyImported: 0, skipped: 0, problems: 0 };
  const say = (line = "") => report.lines.push(line);
  const sayText = (label: string, text: string) => {
    say(`  ${label}:`);
    for (const line of text.split("\n")) say(`    ${line}`);
  };
  say(confirmed ? "Importing:" : "Dry run. Nothing is written. Check every record for personal data.");
  if (unknown.length > 0) say(`Ignored columns: ${unknown.join(", ")}.`);

  const entryIdOf = new Map([...imported].map(([externalId, row]) => [externalId, row.entryId]));
  for (const item of planned) {
    say();
    say(`■ ${item.title} — id ${item.id}`);
    if (item.kind === "skipped") {
      report.skipped += 1;
      say("  Skipped (--skip).");
      continue;
    }
    if (item.kind === "imported") {
      report.alreadyImported += 1;
      say(`  Already imported as LB-${item.number}.`);
      continue;
    }
    if (item.kind === "problem") {
      report.problems += 1;
      say(`  Not imported: ${item.problem}`);
      continue;
    }
    const { input } = item;
    for (const note of item.notes) say(`  Note: ${note}`);
    if (!confirmed) {
      report.wouldCreate += 1;
      const impact = input.impact ? IMPACT_LABELS[input.impact] : NOT_SET;
      if (input.type === "decision") {
        say(`  Decided on ${defaultFormatter.date(input.decidedOn)} by ${names.get(input.deciderId)}; ${HOW_DECIDED_LABELS[input.howDecided]}; team ${item.teamName}.`);
        const reversibility = input.reversibility ? REVERSIBILITY_LABELS[input.reversibility] : NOT_SET;
        say(`  Impact: ${impact}; reversibility: ${reversibility}.`);
        if (input.reversibilityReason) say(`  Why one-way: ${input.reversibilityReason}`);
        if (input.effectiveDate) say(`  Effective from ${defaultFormatter.date(input.effectiveDate)}.`);
        if (input.involvedIds.length) say(`  Involved: ${input.involvedIds.map((id) => names.get(id)).join(", ")}.`);
      } else {
        say(`  ${TYPE_LABELS[input.type]} of ${defaultFormatter.date(item.date)}; team ${item.teamName}.`);
        say(`  Impact: ${impact}.`);
      }
      if (item.affectedTeamNames.length) say(`  Affected teams: ${item.affectedTeamNames.join(", ")}.`);
      if (item.tagNames.length) say(`  Tags: ${item.tagNames.join(", ")}.`);
      if (item.related.length) say(`  Related: ${item.related.join(", ")}.`);
      say(`  Summary: ${input.summary}`);
      if (input.body) sayText(input.type === "decision" ? "Context" : "Details", input.body);
      if (input.type === "decision") sayText("Decision text", input.decisionText);
      if (input.rationale) sayText("Rationale", input.rationale);
      if (input.links.length) say(`  Links: ${input.links.join(" ")}`);
      continue;
    }
    try {
      // The normal command: audit event and webhook, no channel post, the
      // original date, and the row id in the same transaction.
      const logOptions = {
        announce: false,
        importedFrom: { source: IMPORT_SOURCE, externalId: item.id },
        publishedAt: importedPublishedAt(item.date, now),
      };
      const withRelated = { ...input, relatedIds: item.related.map((relatedId) => entryIdOf.get(relatedId)!) };
      const actorRef = { personId: actor.id, isAdmin: true };
      const created =
        withRelated.type === "decision"
          ? await logDecision(db, actorRef, withRelated, now, logOptions)
          : await createNote(db, actorRef, withRelated, now, logOptions);
      entryIdOf.set(item.id, created!.id);
      report.created += 1;
      say(`  Created LB-${created!.number}.`);
    } catch (error) {
      // Another run imported this row meanwhile; nothing was written here.
      if ((error as { code?: string }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505") {
        const other = (await importedEntries()).get(item.id);
        if (other) entryIdOf.set(item.id, other.entryId);
        report.alreadyImported += 1;
        say("  Already imported (by another run).");
        continue;
      }
      // Stop, but keep the report: the records above were created.
      report.failed = error instanceof Error ? error.message : String(error);
      say(`  Failed: ${report.failed}`);
      say("  Stopped here. The records above were created; fix the file and run again (they are skipped then).");
      break;
    }
  }
  say();
  if (confirmed) {
    say(`Created ${report.created}, already imported ${report.alreadyImported}, skipped ${report.skipped}, not importable ${report.problems}.`);
  } else {
    say(`Would create ${report.wouldCreate}, already imported ${report.alreadyImported}, skipped ${report.skipped}, not importable ${report.problems}.`);
    say(`Review fingerprint: ${fingerprint}`);
    say(`To import exactly these records, run again with the same file and options and --confirm-no-personal-data ${fingerprint}`);
  }
  return report;
}
