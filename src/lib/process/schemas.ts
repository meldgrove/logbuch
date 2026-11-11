import { z } from "zod";
import { AFFECTED_TEAMS_MAX, INVOLVED_MAX, LINKS_MAX, RELATED_MAX, SUMMARY_MAX, TAGS_MAX, TEXT_MAX, TITLE_MAX } from "@/lib/entries/constants";
import { impactSchema, reversibilitySchema } from "@/lib/entries/schemas";

/*
 * Form schemas for proposals and the process actions. Shared by the browser
 * forms and the Server Actions; keep free of server-only imports.
 */

export const QUESTION_MAX = 300;
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
    .transform((value) => value || undefined)
    .optional();

const optionalUuid = (message: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : undefined))
    .pipe(z.uuid({ error: message }).optional());

const optionalDate = (message: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : undefined))
    .pipe(z.iso.date({ error: message }).optional());

const idList = (label: string, max: number) =>
  z
    .array(z.uuid({ error: `${label} contains an invalid value.` }))
    .max(max, `Choose at most ${max}.`)
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

const personalDataConfirmed = z.literal("on", { error: "Confirm that the entry contains no personal data." });

/**
 * Saving a draft only needs a title and a question. Everything else is
 * checked when the proposal is submitted. Without a summary, the question
 * is the summary.
 */
export const proposalDraftSchema = z.object({
  title: text("Title", TITLE_MAX),
  question: text("Question", QUESTION_MAX),
  summary: optionalText("Summary", SUMMARY_MAX),
  body: optionalText("Context", TEXT_MAX),
  proposalText: optionalText("Proposal", TEXT_MAX),
  reversibility: reversibilitySchema,
  reversibilityReason: optionalText("Why one-way", NOTE_MAX),
  impact: z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : undefined))
    .pipe(impactSchema.optional()),
  deciderId: optionalUuid("Choose the decider."),
  consentGiverIds: idList("Consent givers", INVOLVED_MAX),
  feedbackGiverIds: idList("Feedback from", INVOLVED_MAX),
  affectedTeamIds: idList("Affected teams", AFFECTED_TEAMS_MAX),
  teamId: z.uuid({ error: "Choose a team." }),
  tagIds: idList("Tags", TAGS_MAX),
  feedbackDeadline: optionalDate("Enter a valid feedback deadline."),
  objectionPeriodDays: z.coerce
    .number<string>({ error: "Enter the objection period in working days." })
    .int("Enter whole working days.")
    .min(1, "At least 1 working day.")
    .max(60, "At most 60 working days."),
  supersedesId: optionalUuid("Choose a valid decision."),
  reviewDate: optionalDate("Enter a valid review date."),
  links,
  relatedIds: idList("Related entries", RELATED_MAX),
});

export const submitSchema = z.object({ personalDataConfirmed });

export const versionSchema = z.object({
  proposalText: text("Proposal", TEXT_MAX),
  changeNote: optionalText("Change note", NOTE_MAX),
  personalDataConfirmed,
});

export const responseSchema = z.object({
  kind: z.enum(["question", "feedback", "objection"]),
  text: text("Text", TEXT_MAX),
});

export const goSchema = z.object({
  text: optionalText("Comment", TEXT_MAX),
  /** The version shown to the person; a Go counts only for what they read. */
  version: z.coerce.number<string>().int().min(1),
});

export const answerSchema = z.object({
  questionId: z.uuid(),
  text: text("Answer", TEXT_MAX),
});

export const resolveSchema = z.object({
  responseId: z.uuid(),
  note: optionalText("Note", NOTE_MAX),
});

export const extendSchema = z.object({
  phase: z.enum(["feedback", "objection"]),
  deadline: z.iso.date({ error: "Enter a date." }),
});

export const changeReversibilitySchema = z.object({
  to: reversibilitySchema,
  reason: text("Reason", NOTE_MAX),
  reversibilityReason: optionalText("Why one-way", NOTE_MAX),
  consentGiverIds: idList("Consent givers", INVOLVED_MAX),
});

export const addParticipantSchema = z.object({
  personId: z.uuid({ error: "Choose a person." }),
  role: z.enum(["consent_giver", "feedback_giver"]),
});

export const removeParticipantSchema = z.object({
  personId: z.uuid(),
  role: z.enum(["consent_giver", "feedback_giver"]),
  reason: optionalText("Reason", NOTE_MAX),
});

export const replaceConsentGiverSchema = z.object({
  personId: z.uuid(),
  replacementId: z.uuid({ error: "Choose the new consent giver." }),
  reason: text("Reason", NOTE_MAX),
});

export const changeDeciderSchema = z.object({
  deciderId: z.uuid({ error: "Choose the new decider." }),
  reason: optionalText("Reason", NOTE_MAX),
});

export const publishSchema = z.object({
  summary: text("Summary", SUMMARY_MAX),
  finalText: text("Decision text", TEXT_MAX),
  rationale: text("Rationale", TEXT_MAX),
  objectionHandling: optionalText("How objections were addressed", TEXT_MAX),
  effectiveDate: optionalDate("Enter a valid effective date."),
  personalDataConfirmed,
});

// The rationale of a rejection and the reason for a withdrawal are visible to
// everyone, so they need the personal data confirmation too.
export const rejectSchema = z.object({ rationale: text("Rationale", TEXT_MAX), personalDataConfirmed });

export const withdrawSchema = z.object({ reason: optionalText("Reason", NOTE_MAX), personalDataConfirmed });

export const periodsFormSchema = z.object({
  twoWayFeedback: z.coerce.number<string>().int(),
  twoWayObjection: z.coerce.number<string>().int(),
  oneWayFeedback: z.coerce.number<string>().int(),
  oneWayObjection: z.coerce.number<string>().int(),
});

export type ProposalDraftInput = z.infer<typeof proposalDraftSchema>;
export type VersionInput = z.infer<typeof versionSchema>;
export type ResponseInput = z.infer<typeof responseSchema>;
export type PublishInput = z.infer<typeof publishSchema>;
export type ChangeReversibilityInput = z.infer<typeof changeReversibilitySchema>;

/** Repeated form fields that arrive as lists. */
export const PROPOSAL_LIST_FIELDS = ["consentGiverIds", "feedbackGiverIds", "affectedTeamIds", "tagIds", "links", "relatedIds"] as const;
