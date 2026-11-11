/*
 * Entry constants shared by the server and the browser. Keep this file free
 * of server-only imports.
 */

export const TITLE_MAX = 120;
export const SUMMARY_MAX = 280;
export const TEXT_MAX = 20_000;
export const LINKS_MAX = 10;
export const RELATED_MAX = 10;
export const TAGS_MAX = 10;
export const INVOLVED_MAX = 50;
export const TAG_NAME_MAX = 40;

/** Shown on every form that creates or changes entry content. */
export const PERSONAL_DATA_NOTICE =
  "Logbuch entries are visible to everyone with access and may be shared with connected systems. Do not enter personal data: no health, salary, application, or HR topics, and no assessments of individual people.";
export const PERSONAL_DATA_CONFIRMATION = "I confirm that this entry contains no personal data.";

export const HOW_DECIDED = ["integrative_process", "role_decision", "management_decision", "other"] as const;
export type HowDecided = (typeof HOW_DECIDED)[number];

export const HOW_DECIDED_LABELS: Record<HowDecided, string> = {
  integrative_process: "Integrative decision process",
  role_decision: "Role decision",
  management_decision: "Management decision",
  other: "Other",
};

/** The types of an entry. A proposal is always a decision. */
export const ENTRY_TYPES = ["update", "decision", "learning"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const TYPE_LABELS: Record<EntryType, string> = {
  update: "Update",
  decision: "Decision",
  learning: "Learning",
};

export const TYPE_HELP: Record<EntryType, string> = {
  update: "News from a team: progress, a launch, a change of plan, a result.",
  decision: "Something that was decided and now applies, for example in a meeting or within someone's role.",
  learning: "Something a team learned, for example from a retrospective, an experiment, or a mistake.",
};

/** Who needs to know about an entry. */
export const IMPACTS = ["small", "medium", "large"] as const;
export type Impact = (typeof IMPACTS)[number];

export const IMPACT_LABELS: Record<Impact, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

export const IMPACT_HELP: Record<Impact, string> = {
  small: "Routine. Only the own team needs to know.",
  medium: "Other teams should know: it changes how they work or what they can expect.",
  large: "Everyone in the organization should read it: an organization-wide change, or something critical.",
};

/** Large entries stay at the top of the timeline this long after publication. */
export const MUST_READ_DAYS = 14;

/** Shown for entries from before impact existed. */
export const NOT_SET = "Not set";

export const REVERSIBILITIES = ["two_way", "one_way"] as const;
export type Reversibility = (typeof REVERSIBILITIES)[number];

export const REVERSIBILITY_LABELS: Record<Reversibility, string> = {
  two_way: "Two-way",
  one_way: "One-way",
};

export const REVERSIBILITY_HELP: Record<Reversibility, { label: string; help: string }> = {
  two_way: {
    label: "Two-way: easy to reverse",
    help: "Example: trying a new meeting format for a month.",
  },
  one_way: {
    label: "One-way: hard to reverse",
    help: "Example: signing a multi-year contract or changing employment terms.",
  },
};

export const AFFECTED_TEAMS_MAX = 50;
