import { z } from "zod";
import {
  AFFECTED_TEAMS_MAX,
  HOW_DECIDED,
  IMPACTS,
  INVOLVED_MAX,
  LINKS_MAX,
  RELATED_MAX,
  REVERSIBILITIES,
  SUMMARY_MAX,
  TAG_NAME_MAX,
  TAGS_MAX,
  TEXT_MAX,
  TITLE_MAX,
} from "./constants";

/*
 * One schema per form, used by the browser form and the Server Action.
 * Form values arrive as strings; lists come from repeated fields.
 */

export const NOTE_MAX = 1_000;

const text = (label: string, max: number) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be at most ${max} characters.`);

const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .optional()
    .transform((value) => value ?? "");

const id = (message: string) => z.uuid({ error: message });

const optionalId = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined))
  .pipe(z.uuid({ error: "Choose a valid entry." }).optional());

const optionalDate = (message: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : undefined))
    .pipe(z.iso.date({ error: message }).optional());

const idList = (label: string, max: number) =>
  z
    .array(z.uuid({ error: `${label} contains an invalid value.` }))
    .max(max, `Choose at most ${max} ${label.toLowerCase()}.`)
    .optional()
    .transform((values) => [...new Set(values ?? [])]);

const links = z
  .array(z.string())
  .optional()
  .transform((values) => [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))])
  .pipe(
    z
      .array(z.url({ protocol: /^https?$/, error: "Links must be complete http(s) URLs." }))
      .max(LINKS_MAX, `Add at most ${LINKS_MAX} links.`),
  );

/** The required "no personal data" checkbox. Checked again on the server. */
const personalDataConfirmed = z.literal("on", {
  error: "Confirm that the entry contains no personal data.",
});

export const impactSchema = z.enum(IMPACTS, { error: "Choose the impact." });
export const reversibilitySchema = z.enum(REVERSIBILITIES, { error: "Choose two-way or one-way." });

/** Fields of every entry. */
const entryFields = {
  title: text("Title", TITLE_MAX),
  summary: text("Summary", SUMMARY_MAX),
  body: optionalText("Details", TEXT_MAX),
  impact: impactSchema,
  teamId: id("Choose a team."),
  affectedTeamIds: idList("Affected teams", AFFECTED_TEAMS_MAX),
  tagIds: idList("Tags", TAGS_MAX),
  links,
  relatedIds: idList("Related entries", RELATED_MAX),
  personalDataConfirmed,
};

/** An update or a learning: published right away, editable by its author. */
export const noteInputSchema = z.object({
  type: z.enum(["update", "learning"], { error: "Choose a type." }),
  ...entryFields,
  rationale: optionalText("Rationale", TEXT_MAX),
});

const decisionObject = z.object({
  type: z.literal("decision", { error: "Choose a type." }),
  ...entryFields,
  rationale: text("Rationale", TEXT_MAX),
  decisionText: text("Decision text", TEXT_MAX),
  reversibility: reversibilitySchema,
  reversibilityReason: optionalText("Why one-way", NOTE_MAX),
  howDecided: z.enum(HOW_DECIDED, { error: "Choose how it was decided." }),
  deciderId: id("Choose the decider."),
  involvedIds: idList("Involved people", INVOLVED_MAX),
  decidedOn: z.iso.date({ error: "Enter the date of the decision." }),
  effectiveDate: optionalDate("Enter a valid effective date."),
  reviewDate: optionalDate("Enter a valid review date."),
  supersedesId: optionalId,
});

/**
 * A decision logged directly. Published right away and
 * not edited. The reason for one-way is checked even when other fields have
 * errors, so the form shows every problem at once.
 */
export const decisionInputSchema = decisionObject.refine((input) => input.reversibility !== "one_way" || Boolean(input.reversibilityReason?.trim()), {
  path: ["reversibilityReason"],
  message: "Explain why the decision is hard to reverse.",
  when: (payload) => {
    const value = payload.value as { reversibility?: unknown } | undefined;
    return value?.reversibility === "one_way";
  },
});

/** An old decision from the CSV import: impact and reversibility may be unknown. */
export const importedDecisionSchema = decisionObject.extend({
  impact: impactSchema.nullable(),
  reversibility: reversibilitySchema.nullable(),
});

/** An old update or learning from the CSV import: the impact may be unknown. */
export const importedNoteSchema = noteInputSchema.extend({
  impact: impactSchema.nullable(),
});

/** The "Log something" form: the fields depend on the type. */
export const logInputSchema = z.discriminatedUnion("type", [noteInputSchema, decisionInputSchema], { error: "Choose a type." });

/** Changes the impact of a published entry. */
export const impactInputSchema = z.object({ impact: impactSchema });

export const addendumInputSchema = z.object({
  text: text("Text", TEXT_MAX),
  personalDataConfirmed,
});

export const tagInputSchema = z.object({
  name: text("Name", TAG_NAME_MAX),
});

export type NoteInput = z.infer<typeof noteInputSchema>;
export type DecisionInput = z.infer<typeof decisionInputSchema>;
export type LogInput = z.infer<typeof logInputSchema>;
export type ImportedDecisionInput = z.infer<typeof importedDecisionSchema>;
export type ImportedNoteInput = z.infer<typeof importedNoteSchema>;
export type AddendumInput = z.infer<typeof addendumInputSchema>;
export type TagInput = z.infer<typeof tagInputSchema>;

/** Field names that repeat in a form and arrive as lists. */
export const LIST_FIELDS = [
  "tagIds",
  "links",
  "relatedIds",
  "involvedIds",
  "consentGiverIds",
  "feedbackGiverIds",
  "affectedTeamIds",
] as const;

/** Turns FormData into a plain object for the schemas above. */
export function formDataToObject(formData: FormData): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(formData.keys())) {
    if (key.startsWith("$ACTION")) continue;
    const values = formData.getAll(key).filter((value): value is string => typeof value === "string");
    result[key] = (LIST_FIELDS as readonly string[]).includes(key) ? values : (values[0] ?? "");
  }
  return result;
}

export type FieldErrors = Record<string, string>;

/** The first message per field, keyed by the top-level field name. */
export function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    errors[field] ??= issue.message;
  }
  return errors;
}
