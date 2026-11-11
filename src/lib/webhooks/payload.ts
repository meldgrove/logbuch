import type { EntryType, HowDecided, Impact, Reversibility } from "@/lib/entries/constants";
import { formatEntryRef } from "@/lib/entries/refs";

/*
 * What Logbuch posts to the webhook, as a pure mapping from an entry's facts.
 * Published updates, learnings, and logged decisions, and decided or rejected
 * proposals are sent; drafts, open proposals, and withdrawn proposals are not.
 * Every request carries the whole entry as it is now, so a receiver stores it
 * by `entry.id` and replaces what it had.
 */

export interface EntryFacts {
  entry: {
    id: string;
    number: number;
    type: EntryType;
    status: string;
    title: string;
    summary: string;
    /** Details; for decisions the context. */
    body: string;
    rationale: string;
    impact: Impact | null;
    publishedAt: Date | null;
    supersedesNumber: number | null;
    supersededByNumber: number | null;
  };
  teamName: string;
  authorName: string;
  affectedTeamNames: string[];
  tagNames: string[];
  /** Every decision, logged or from a proposal. */
  decision: {
    reversibility: Reversibility | null;
    howDecided: HowDecided;
    deciderName: string;
  } | null;
  /** Decisions that went through the decision process. */
  proposal: {
    currentVersion: number;
    consentGiverNames: string[];
  } | null;
  outcome: {
    result: "adopted" | "rejected" | "withdrawn" | "recorded";
    finalText: string;
    objectionHandling: string | null;
    /** The date the decision was made (YYYY-MM-DD). */
    decidedOn: string;
    /** When the outcome was recorded in Logbuch. */
    decidedAt: Date;
    decidedByName: string;
  } | null;
  /** Involved people of a logged decision. */
  involvedNames: string[];
  addenda: { text: string; authorName: string; createdAt: Date }[];
  /** Objections still open when a two-way decision was published. */
  openObjections: string[];
}

export interface WebhookPayload {
  event: "entry.changed";
  entry: {
    id: string;
    /** E.g. "LB-12". */
    ref: string;
    url: string;
    type: EntryType;
    /** `published` for logged entries; `decided` or `rejected` for proposals. */
    status: string;
    title: string;
    summary: string;
    details: string;
    rationale: string;
    impact: Impact | null;
    team: string;
    affected_teams: string[];
    tags: string[];
    author: string;
    published_at: string | null;
    /** False once a newer decision replaced this one, or for a rejected proposal. */
    in_force: boolean;
    supersedes: string | null;
    superseded_by: string | null;
    decision: {
      result: "adopted" | "rejected" | "recorded";
      /** The decision text; empty for a rejected proposal. */
      text: string;
      reversibility: Reversibility | null;
      how_decided: HowDecided;
      decider: string;
      decided_on: string;
      decided_at: string;
      objection_handling: string | null;
      open_objections: string[];
      consent_givers: string[];
      involved: string[];
      proposal_version: number | null;
    } | null;
    addenda: { text: string; author: string; created_at: string }[];
  };
}

const refOrNull = (number: number | null) => (number === null ? null : formatEntryRef(number));

/** The webhook payload of an entry, or null when the entry is not sent. */
export function toWebhookPayload(facts: EntryFacts, baseUrl: string): WebhookPayload | null {
  const { entry, outcome, decision } = facts;
  if (entry.status === "draft") return null;
  if (entry.type !== "decision" || !facts.proposal) {
    // Logged updates, learnings, and decisions.
    if (entry.status !== "published") return null;
    if (entry.type === "decision" && (!outcome || !decision)) return null;
  } else if ((entry.status !== "decided" && entry.status !== "rejected") || !outcome || !decision) {
    return null;
  }

  const ref = formatEntryRef(entry.number);
  const rejected = outcome?.result === "rejected";
  return {
    event: "entry.changed",
    entry: {
      id: entry.id,
      ref,
      url: `${baseUrl.replace(/\/+$/, "")}/e/${ref}`,
      type: entry.type,
      status: entry.status,
      title: entry.title,
      summary: entry.summary,
      details: entry.body,
      rationale: entry.rationale,
      impact: entry.impact,
      team: facts.teamName,
      affected_teams: facts.affectedTeamNames,
      tags: facts.tagNames,
      author: facts.authorName,
      published_at: entry.publishedAt?.toISOString() ?? null,
      in_force: entry.supersededByNumber === null && !rejected,
      supersedes: refOrNull(entry.supersedesNumber),
      superseded_by: refOrNull(entry.supersededByNumber),
      decision:
        outcome && decision && outcome.result !== "withdrawn"
          ? {
              result: outcome.result,
              text: rejected ? "" : outcome.finalText,
              reversibility: decision.reversibility,
              how_decided: decision.howDecided,
              decider: decision.deciderName,
              decided_on: outcome.decidedOn,
              decided_at: outcome.decidedAt.toISOString(),
              objection_handling: outcome.objectionHandling,
              open_objections: facts.openObjections,
              consent_givers: facts.proposal?.consentGiverNames ?? [],
              involved: facts.involvedNames,
              proposal_version: facts.proposal?.currentVersion ?? null,
            }
          : null,
      addenda: facts.addenda.map((a) => ({ text: a.text, author: a.authorName, created_at: a.createdAt.toISOString() })),
    },
  };
}
