import {
  ENTRY_TYPES,
  HOW_DECIDED,
  HOW_DECIDED_LABELS,
  IMPACT_LABELS,
  IMPACTS,
  INVOLVED_MAX,
  LINKS_MAX,
  RELATED_MAX,
  REVERSIBILITIES,
  REVERSIBILITY_LABELS,
  SUMMARY_MAX,
  TEXT_MAX,
  TITLE_MAX,
  TYPE_LABELS,
  type EntryType,
  type HowDecided,
  type Impact,
  type Reversibility,
} from "@/lib/entries/constants";
import { importedDecisionSchema, importedNoteSchema, type ImportedDecisionInput, type ImportedNoteInput } from "@/lib/entries/schemas";
import { clipText } from "@/lib/format";

/*
 * Import of old entries from a CSV file, as pure functions:
 * one row to the input of `logDecision` or `createNote`. The columns are
 * Logbuch's own (see docs/entry-import-template.csv); the file can come from
 * any earlier log. Logbuch has no connection to the old systems.
 */

/** The columns, in template order. `decided_on` is the old name of `date`. */
export const COLUMNS = [
  "id",
  "type",
  "title",
  "date",
  "summary",
  "details",
  "decision_text",
  "rationale",
  "impact",
  "reversibility",
  "why_one_way",
  "how_decided",
  "decider_email",
  "involved_emails",
  "effective_date",
  "team",
  "affected_teams",
  "tags",
  "related",
  "links",
  "decided_on",
] as const;

/** Columns only a decision may fill. */
export const DECISION_COLUMNS = [
  "decision_text",
  "reversibility",
  "why_one_way",
  "how_decided",
  "decider_email",
  "involved_emails",
  "effective_date",
] as const;

export const DEFAULT_RATIONALE = "Imported from an earlier decision log.";

export interface Person {
  id: string;
  name: string;
}

interface Named {
  id: string;
  name: string;
}

export interface MappingContext {
  /** Today in the server's time zone; an entry's date may not be later. */
  today: string;
  /** Team when the row has none. */
  defaultTeam: Named;
  /** Active teams, by lower-case name. */
  teamsByName: Map<string, Named>;
  /** Active tags, by lower-case name. */
  tagsByName: Map<string, Named>;
  /** People with access, by lower-case work email. */
  peopleByEmail: Map<string, Person>;
  /** Decider when a row has no decider email, or one without access. */
  fallbackDecider?: Person;
}

export type ImportedInput = ImportedDecisionInput | ImportedNoteInput;

export interface MappedEntry {
  /** `relatedIds` stays empty: related rows get their entry ids during the import. */
  input: ImportedInput;
  /** The day the entry was published or decided (YYYY-MM-DD). */
  date: string;
  /** Row ids of earlier rows, or of entries imported before. */
  related: string[];
  teamName: string;
  tagNames: string[];
  affectedTeamNames: string[];
  notes: string[];
}

export type MappedRow = ({ ok: true } & MappedEntry) | { ok: false; problem: string };

const clip = clipText;
const fail = (problem: string): MappedRow => ({ ok: false, problem });

/** YYYY-MM-DD, or DD.MM.YYYY as German spreadsheets write dates. */
export function parseDate(value: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : german ? [german[3], german[2]!.padStart(2, "0"), german[1]!.padStart(2, "0")] : [];
  if (!year) return null;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

/** The value of a column as one of `options`, by key or label (any case). */
function parseOption<T extends string>(value: string, options: readonly T[], labels: Record<T, string>): T | null {
  const key = value.trim().toLowerCase();
  return options.find((option) => option === key || option === key.replace(/-/g, "_") || labels[option].toLowerCase() === key) ?? null;
}

/** Older names of these options are still accepted. */
const LEGACY_HOW_DECIDED: Record<string, HowDecided> = {
  integrative_meeting: "integrative_process",
  "integrative process in a meeting": "integrative_process",
};

function parseHowDecided(value: string): HowDecided | null {
  if (!value.trim()) return "other";
  return LEGACY_HOW_DECIDED[value.trim().toLowerCase()] ?? parseOption(value, HOW_DECIDED, HOW_DECIDED_LABELS);
}

/** The first paragraph of text on one line, without Markdown list and heading markers. */
function firstParagraph(text: string): string {
  return (
    text
      .split(/\n\s*\n/)
      .map((p) =>
        p
          // Markdown line prefixes only: headings, quotes, list markers, to-dos.
          .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm, "")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/\s*\n\s*/g, " ")
          .trim(),
      )
      .find((p) => p.length > 0) ?? ""
  );
}

const split = (value: string, pattern: RegExp) =>
  value
    .split(pattern)
    .map((part) => part.trim())
    .filter(Boolean);

/** Names separated by commas or semicolons, looked up by lower-case name; a string says which one is missing. */
function lookUp(value: string, byName: Map<string, Named>, missing: (name: string) => string): Named[] | string {
  const found: Named[] = [];
  for (const name of split(value, /[,;]/)) {
    const item = byName.get(name.toLowerCase());
    if (!item) return missing(name);
    if (!found.some((f) => f.id === item.id)) found.push(item);
  }
  return found;
}

const zodProblem = (error: { issues: { message: string }[] }) => error.issues.map((issue) => issue.message).join(" ");

/** Maps one CSV row to the input of `logDecision` or `createNote`, or says why it cannot be imported. */
export function mapRow(row: Record<string, string>, ctx: MappingContext): MappedRow {
  let type: EntryType = "decision";
  if (row.type?.trim()) {
    const parsedType = parseOption(row.type, ENTRY_TYPES, TYPE_LABELS);
    if (!parsedType) return fail(`"${row.type}" in type is not one of: ${ENTRY_TYPES.join(", ")}.`);
    type = parsedType;
  }
  const title = row.title ?? "";
  if (!title) return fail("The title is empty.");
  const dateColumn = row.date || row.decided_on === undefined ? "date" : "decided_on";
  const rawDate = row[dateColumn] ?? "";
  const date = parseDate(rawDate);
  if (!date) return fail(`"${rawDate}" in ${dateColumn} is not a date (YYYY-MM-DD or DD.MM.YYYY).`);
  if (date > ctx.today) return fail(`${dateColumn} ${date} lies in the future.`);
  // Empty means unknown: shown as "not set".
  let impact: Impact | null = null;
  if (row.impact?.trim()) {
    impact = parseOption(row.impact, IMPACTS, IMPACT_LABELS);
    if (!impact) return fail(`"${row.impact}" in impact is not one of: ${IMPACTS.join(", ")}.`);
  }
  let team = ctx.defaultTeam;
  if (row.team) {
    const found = ctx.teamsByName.get(row.team.toLowerCase());
    if (!found) return fail(`There is no active team "${row.team}".`);
    team = found;
  }
  const affectedTeams = lookUp(row.affected_teams ?? "", ctx.teamsByName, (name) => `There is no active team "${name}" in affected_teams.`);
  if (typeof affectedTeams === "string") return fail(affectedTeams);
  const tags = lookUp(row.tags ?? "", ctx.tagsByName, (name) => `There is no active tag "${name}".`);
  if (typeof tags === "string") return fail(tags);
  const related = [...new Set(split(row.related ?? "", /[\s,;]+/))];
  if (related.includes(row.id ?? "")) return fail("An entry cannot be related to itself.");
  if (related.length > RELATED_MAX) return fail(`More than ${RELATED_MAX} related entries.`);
  const links = split(row.links ?? "", /\s+/);
  if (links.length > LINKS_MAX) return fail(`More than ${LINKS_MAX} links.`);
  const details = row.details ?? "";
  if (details.length > TEXT_MAX) return fail(`details is longer than ${TEXT_MAX} characters.`);

  const notes: string[] = [];
  if (title.length > TITLE_MAX) notes.push(`The title was shortened to ${TITLE_MAX} characters.`);
  const summaryOf = (source: string) => {
    if (source.length > SUMMARY_MAX) notes.push(`The summary was shortened to ${SUMMARY_MAX} characters.`);
    return clip(source, SUMMARY_MAX);
  };
  const common = {
    title: clip(title, TITLE_MAX),
    teamId: team.id,
    affectedTeamIds: affectedTeams.map((t) => t.id),
    tagIds: tags.map((t) => t.id),
    links,
    relatedIds: [],
    body: details,
    impact,
    personalDataConfirmed: "on",
  };
  const mapped = { date, related, teamName: team.name, tagNames: tags.map((t) => t.name), affectedTeamNames: affectedTeams.map((t) => t.name), notes };

  if (type !== "decision") {
    const used = DECISION_COLUMNS.filter((column) => row[column]?.trim());
    if (used.length > 0) return fail(`${used.join(", ")} ${used.length === 1 ? "is" : "are"} only for decisions.`);
    const rationale = row.rationale ?? "";
    if (rationale.length > TEXT_MAX) return fail(`rationale is longer than ${TEXT_MAX} characters.`);
    const parsed = importedNoteSchema.safeParse({ ...common, type, summary: summaryOf(row.summary || firstParagraph(details) || title), rationale });
    if (!parsed.success) return fail(zodProblem(parsed.error));
    return { ok: true, input: parsed.data, ...mapped };
  }

  const howDecided = parseHowDecided(row.how_decided ?? "");
  if (!howDecided) return fail(`"${row.how_decided}" in how_decided is not one of: ${HOW_DECIDED.join(", ")}.`);
  let reversibility: Reversibility | null = null;
  if (row.reversibility?.trim()) {
    reversibility = parseOption(row.reversibility, REVERSIBILITIES, REVERSIBILITY_LABELS);
    if (!reversibility) return fail(`"${row.reversibility}" in reversibility is not one of: ${REVERSIBILITIES.join(", ")}.`);
  }
  const whyOneWay = row.why_one_way ?? "";
  if (whyOneWay && reversibility !== "one_way") return fail("why_one_way is only for one-way decisions.");
  let effectiveDate: string | undefined;
  if (row.effective_date?.trim()) {
    effectiveDate = parseDate(row.effective_date.trim()) ?? undefined;
    if (!effectiveDate) return fail(`"${row.effective_date}" in effective_date is not a date (YYYY-MM-DD or DD.MM.YYYY).`);
  }

  const deciderEmail = (row.decider_email ?? "").toLowerCase();
  let decider = deciderEmail ? ctx.peopleByEmail.get(deciderEmail) : undefined;
  if (!decider) {
    if (!ctx.fallbackDecider) {
      return fail(
        deciderEmail
          ? `${row.decider_email} has no Logbuch access. Pass --fallback-decider to import it anyway.`
          : "decider_email is empty. Pass --fallback-decider to import it anyway.",
      );
    }
    decider = ctx.fallbackDecider;
    notes.push(`Decider: ${decider.name} (${row.decider_email || "no decider_email"} has no Logbuch access).`);
  }

  const involved: Person[] = [];
  for (const email of split(row.involved_emails ?? "", /[\s,;]+/)) {
    const found = ctx.peopleByEmail.get(email.toLowerCase());
    if (found) {
      if (found.id !== decider.id) involved.push(found);
    } else notes.push(`${email} has no Logbuch access and is not listed as involved.`);
  }

  const decisionText = row.decision_text || title;
  if (decisionText.length > TEXT_MAX) return fail(`decision_text is longer than ${TEXT_MAX} characters.`);
  const rationale = row.rationale || DEFAULT_RATIONALE;
  if (rationale.length > TEXT_MAX) return fail(`rationale is longer than ${TEXT_MAX} characters.`);

  const parsed = importedDecisionSchema.safeParse({
    ...common,
    type: "decision",
    summary: summaryOf(row.summary || firstParagraph(decisionText) || title),
    decisionText,
    rationale,
    reversibility,
    reversibilityReason: whyOneWay,
    deciderId: decider.id,
    involvedIds: [...new Set(involved.map((p) => p.id))].slice(0, INVOLVED_MAX),
    howDecided,
    decidedOn: date,
    effectiveDate,
  });
  if (!parsed.success) return fail(zodProblem(parsed.error));
  return { ok: true, input: parsed.data, ...mapped };
}
