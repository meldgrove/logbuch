import { addWorkingDays, isWorkingDay, previousWorkingDay } from "@/lib/calendar";
import type { NotificationChannel } from "@/lib/db/schema";
import { IMPACT_LABELS, NOT_SET, TYPE_LABELS, type EntryType, type Impact } from "@/lib/entries/constants";
import { dateToken, serverDate } from "@/lib/format";
import {
  awaitsAnswer,
  blockingObjections,
  consentGivers,
  hasGoOnEarlierVersion,
  isConsentGiver,
  readiness,
  type ProposalSnapshot,
} from "@/lib/process/rules";
import type { ChannelPost, NotificationMessage } from "./types";

/*
 * Who gets which message, as pure functions. Events go to
 * Slack, reminders by email. Each planned delivery has a key that names the
 * event, the occurrence, and the recipient, so it is recorded only once.
 */

export interface PlannedDelivery {
  key: string;
  event: string;
  entryId: string;
  /** Empty for posts to the Logbuch Slack channel. */
  recipientId: string | null;
  channel: NotificationChannel;
  message: NotificationMessage;
}

export interface EntryInfo {
  id: string;
  number: number;
  title: string;
}

/** What a channel post says about an entry. */
export interface PostInfo {
  type: EntryType;
  summary: string;
  impact: Impact | null;
  affectedTeams: string[];
}

export interface ProposalContext {
  entry: EntryInfo;
  s: ProposalSnapshot;
  /** For the posts to the Logbuch Slack channel. */
  post: PostInfo;
  /** Who caused the event. They are not notified about it. */
  actor: { personId: string; name: string } | null;
}

export type ProposalEvent =
  | { type: "submitted" }
  | { type: "question"; responseId: string }
  | { type: "answered"; questionId: string }
  | { type: "objection"; responseId: string }
  | { type: "version"; version: number }
  | { type: "objection_round" }
  | { type: "deadline_extended"; phase: "feedback" | "objection"; deadline: string }
  | { type: "one_way"; at: Date; backToFeedback: boolean }
  | { type: "participant_added"; personId: string; role: "consent_giver" | "feedback_giver"; at: Date }
  | { type: "decider_changed"; at: Date }
  | { type: "ready"; since: Date }
  | { type: "closed"; result: "decided" | "rejected" | "withdrawn" };

export type LostRole = "decider" | "consent_giver" | "feedback_giver";

type Recipient = [personId: string, message: NotificationMessage];

const refOf = (entry: EntryInfo) => `LB-${entry.number}`;

function message(
  entry: EntryInfo,
  subject: string,
  text: string,
  options: { deadline?: NotificationMessage["deadline"]; path?: string } = {},
): NotificationMessage {
  const ref = refOf(entry);
  return {
    subject: `${subject}: ${ref} ${entry.title}`,
    ref,
    title: entry.title,
    text,
    ...(options.deadline ? { deadline: options.deadline } : {}),
    path: options.path ?? `/e/${ref}`,
  };
}

/** One delivery per recipient: the first message listed for a person wins. */
function deliveries(
  entryId: string,
  event: string,
  occurrence: string,
  channel: NotificationChannel,
  recipients: Recipient[],
  exclude: string | null = null,
): PlannedDelivery[] {
  const seen = new Set<string>();
  const planned: PlannedDelivery[] = [];
  for (const [recipientId, msg] of recipients) {
    if (recipientId === exclude || seen.has(recipientId)) continue;
    seen.add(recipientId);
    planned.push({ key: `${event}:${occurrence}:${recipientId}`, event, entryId, recipientId, channel, message: msg });
  }
  return planned;
}

const feedbackDeadline = (s: ProposalSnapshot) => ({ label: "Feedback deadline", date: s.feedbackDeadline });

/** The deadline of the current phase. */
function phaseDeadline(s: ProposalSnapshot): NotificationMessage["deadline"] {
  if (s.status === "objection_round" && s.objectionDeadline) return { label: "Objection deadline", date: s.objectionDeadline };
  if (s.status === "feedback") return feedbackDeadline(s);
  return undefined;
}

/** What a requested person should do now. */
function requestFor(s: ProposalSnapshot, personId: string): string {
  const consent = isConsentGiver(s, personId);
  if (s.status === "feedback") return consent ? "Give feedback now; your Go follows in the objection round." : "Give your feedback.";
  if (s.reversibility === "two_way") return "Answer with a Go or an objection.";
  return consent ? `Give your Go on version ${s.currentVersion}, or raise an objection.` : "You can raise an objection.";
}

const consentFirst = (s: ProposalSnapshot) => [
  ...s.participants.filter((p) => p.role === "consent_giver"),
  ...s.participants.filter((p) => p.role === "feedback_giver"),
];

/** Slack messages for an event on a proposal. */
export function planProposalEvent(ctx: ProposalContext, event: ProposalEvent): PlannedDelivery[] {
  const { entry, s } = ctx;
  const actor = ctx.actor?.name ?? "Someone";
  const exclude = ctx.actor?.personId ?? null;
  const slack = (name: string, occurrence: string, recipients: Recipient[]) =>
    deliveries(entry.id, `proposal.${name}`, occurrence, "slack", recipients, exclude);

  switch (event.type) {
    case "submitted":
      return slack("submitted", entry.id, [
        ...consentFirst(s).map((p): Recipient =>
          p.role === "consent_giver"
            ? [p.personId, message(entry, "Consent requested", `${actor} asks for your consent on a one-way decision. ${requestFor(s, p.personId)}`, { deadline: feedbackDeadline(s) })]
            : [p.personId, message(entry, "Feedback requested", `${actor} asks for your feedback.`, { deadline: feedbackDeadline(s) })],
        ),
        [s.deciderId, message(entry, "You are the decider", `${actor} named you the decider. You decide after the objection round.`, { deadline: feedbackDeadline(s) })],
      ]).concat(
        channelPost(entry, ctx.post, "submitted", message(entry, "New proposal", `${actor} proposes a ${s.reversibility === "one_way" ? "one-way" : "two-way"} decision. Feedback is open.`, { deadline: feedbackDeadline(s) })),
      );

    case "question":
      return slack("question", event.responseId, [
        [s.proposerId, message(entry, "New question", `${actor} asked a question. Answer it on the proposal page.`)],
      ]);

    case "answered": {
      const asker = s.responses.find((r) => r.id === event.questionId && r.kind === "question")?.personId;
      if (!asker) return [];
      return slack("answered", event.questionId, [[asker, message(entry, "Question answered", `${actor} answered your question.`)]]);
    }

    case "objection": {
      const blocking = blockingObjections(s).some((r) => r.id === event.responseId);
      const text = `${actor} raised an objection.${blocking ? " It blocks the decision until it is resolved." : ""}`;
      return slack("objection", event.responseId, [
        [s.proposerId, message(entry, "New objection", text)],
        [s.deciderId, message(entry, "New objection", text)],
      ]);
    }

    case "version": {
      const confirm = consentGivers(s)
        .filter((p) => hasGoOnEarlierVersion(s, p.personId))
        .map((p): Recipient => [
          p.personId,
          message(entry, "Please confirm again", `Version ${event.version} is out. Your Go was for an earlier version: read the changes and give your Go again.`, {
            deadline: phaseDeadline(s),
          }),
        ]);
      const feedbackAuthors = [...new Set(s.responses.filter((r) => r.kind === "feedback").map((r) => r.personId))].map((personId): Recipient => [
        personId,
        message(entry, "New version", `Version ${event.version} is out. You gave feedback on an earlier version.`),
      ]);
      return slack("version", `${entry.id}:v${event.version}`, [...confirm, ...feedbackAuthors]);
    }

    case "objection_round": {
      const deadline = phaseDeadline(s);
      return slack("objection_round", `${entry.id}:${s.objectionDeadline}`, [
        ...consentFirst(s).map((p): Recipient => {
          const consent = isConsentGiver(s, p.personId);
          const subject = consent ? "Your Go is needed" : s.reversibility === "two_way" ? "Go or objection requested" : "Objection round started";
          return [p.personId, message(entry, subject, `The objection round has started. ${requestFor(s, p.personId)}`, { deadline })];
        }),
        [s.deciderId, message(entry, "Objection round started", "The objection round has started. You decide once it is over.", { deadline })],
      ]);
    }

    case "deadline_extended": {
      const label = event.phase === "feedback" ? "Feedback deadline" : "Objection deadline";
      return slack(
        "deadline_extended",
        `${entry.id}:${event.phase}:${event.deadline}`,
        s.participants
          .filter((p) => awaitsAnswer(s, p.personId))
          .map((p): Recipient => [
            p.personId,
            message(entry, "Deadline extended", `${actor} extended the ${event.phase} deadline. ${requestFor(s, p.personId)}`, {
              deadline: { label, date: event.deadline },
            }),
          ]),
      );
    }

    case "one_way": {
      const changed = `${actor} changed this proposal to a one-way decision.${event.backToFeedback ? " It is back in the feedback phase." : ""}`;
      const options = { deadline: feedbackDeadline(s) };
      return slack("one_way", `${entry.id}:${event.at.toISOString()}`, [
        ...consentFirst(s).map((p): Recipient =>
          p.role === "consent_giver"
            ? [p.personId, message(entry, "Now a one-way decision", `${changed} You are a consent giver. ${requestFor(s, p.personId)}`, options)]
            : [p.personId, message(entry, "Now a one-way decision", changed, options)],
        ),
        [s.deciderId, message(entry, "Now a one-way decision", changed, options)],
        [s.proposerId, message(entry, "Now a one-way decision", changed, options)],
      ]);
    }

    case "participant_added": {
      const role = event.role === "consent_giver" ? "a consent giver" : "a feedback giver";
      return slack("participant_added", `${entry.id}:${event.role}:${event.at.toISOString()}`, [
        [event.personId, message(entry, "You were added", `${actor} added you as ${role}. ${requestFor(s, event.personId)}`, { deadline: phaseDeadline(s) })],
      ]);
    }

    case "decider_changed":
      return slack("decider_changed", `${entry.id}:${event.at.toISOString()}`, [
        [s.deciderId, message(entry, "You are the decider", `${actor} made you the decider of this proposal.`, { deadline: phaseDeadline(s) })],
      ]);

    case "ready":
      // One occurrence per time the proposal becomes ready (proposal.ready_since).
      return slack("ready", `${entry.id}:${event.since.toISOString()}`, [
        [s.deciderId, message(entry, "Ready to decide", "This proposal is ready to decide. Publish the decision, or reject the proposal.", { path: `/e/${refOf(entry)}/decide` })],
      ]);

    case "closed": {
      const outcomes: Record<typeof event.result, [subject: string, text: string]> = {
        decided: ["Decided", `${actor} published the decision.`],
        rejected: ["Rejected", `${actor} rejected the proposal.`],
        withdrawn: ["Withdrawn", `${actor} withdrew the proposal.`],
      };
      const [subject, text] = outcomes[event.result];
      const everyone = [s.proposerId, s.deciderId, ...s.participants.map((p) => p.personId), ...s.responses.map((r) => r.personId)];
      const planned = slack("closed", entry.id, everyone.map((personId): Recipient => [personId, message(entry, subject, text)]));
      // Withdrawn proposals are not announced in the channel.
      return event.result === "withdrawn" ? planned : planned.concat(channelPost(entry, ctx.post, event.result, message(entry, subject, text)));
    }
  }
}

/** Someone without access who is still the decider or listed on an open proposal, in one role. */
export interface LostAccessRow {
  entry: EntryInfo;
  proposerId: string;
  personId: string;
  name: string;
  /** When the person lost access. */
  since: Date;
  role: LostRole;
}

const LOST_ROLE_NAMES: Record<LostRole, string> = { decider: "the decider", consent_giver: "a consent giver", feedback_giver: "a feedback giver" };

/**
 * Slack messages to proposers about people who lost access: one per proposal
 * and person, naming every role they hold there, once per loss of access.
 */
export function planLostAccess(rows: LostAccessRow[]): PlannedDelivery[] {
  const groups = new Map<string, { first: LostAccessRow; roles: LostRole[] }>();
  for (const row of rows) {
    const key = `${row.entry.id}:${row.personId}`;
    const group = groups.get(key) ?? { first: row, roles: [] };
    if (!group.roles.includes(row.role)) group.roles.push(row.role);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(({ first: { entry, proposerId, personId, name, since }, roles }) => {
    const order: LostRole[] = ["decider", "consent_giver", "feedback_giver"];
    const named = order.filter((role) => roles.includes(role)).map((role) => LOST_ROLE_NAMES[role]);
    const text = `${name} no longer has access to Logbuch and is ${named.join(" and ")} on this proposal. Replace them so the decision can go ahead.`;
    return deliveries(entry.id, "proposal.lost_access", `${entry.id}:${personId}:${since.toISOString()}`, "slack", [
      [proposerId, message(entry, "Participant lost access", text)],
    ]);
  });
}

/** The people on an entry who hear about an addendum. */
export interface AddendumFacts {
  authorId: string;
  /** Null for updates and learnings. */
  deciderId: string | null;
  /** Everyone listed on the entry: requested people, or the people involved in a logged decision. */
  listedIds: string[];
}

/** Slack messages for an addendum: the author, the decider, and everyone listed on the entry, except whoever added it. */
export function planAddendum(entry: EntryInfo, addendumId: string, actor: { personId: string; name: string }, facts: AddendumFacts): PlannedDelivery[] {
  const recipientIds = [facts.authorId, ...(facts.deciderId ? [facts.deciderId] : []), ...facts.listedIds];
  return deliveries(
    entry.id,
    "entry.addendum",
    addendumId,
    "slack",
    recipientIds.map((personId): Recipient => [personId, message(entry, "Addendum added", `${actor.name} added an addendum.`)]),
    actor.personId,
  );
}

// ---------------------------------------------------------------------------
// Reminders (email, 09:00 on working days)
// ---------------------------------------------------------------------------

export interface ReminderContext {
  entry: EntryInfo;
  s: ProposalSnapshot;
  /** Today in the server's time zone, a working day. */
  today: string;
  now: Date;
  /** When the proposal last became ready to decide (proposal.ready_since). */
  readySince?: Date | null;
}

/** The reminder number when `today` is one of the scheduled days, counted in working days from `from`. */
function scheduled(from: string, today: string, offsets: number[]): number | undefined {
  const index = offsets.findIndex((days) => addWorkingDays(from, days) === today);
  return index === -1 ? undefined : index + 1;
}

/** The reminders due today for one proposal. */
export function planReminders(ctx: ReminderContext): PlannedDelivery[] {
  const { entry, s, today } = ctx;
  const email = (name: string, occurrence: string, recipients: Recipient[]) =>
    deliveries(entry.id, `reminder.${name}`, occurrence, "email", recipients);
  const planned: PlannedDelivery[] = [];

  // 1 working day before a feedback or objection deadline.
  const phase = s.status === "feedback" ? "feedback" : s.status === "objection_round" ? "objection" : undefined;
  const deadline = phase === "feedback" ? s.feedbackDeadline : phase === "objection" ? s.objectionDeadline : null;
  if (phase && deadline && today === previousWorkingDay(deadline)) {
    const due = { label: phase === "feedback" ? "Feedback deadline" : "Objection deadline", date: deadline };
    const byEnd = `by the end of ${dateToken(deadline)}`;
    planned.push(
      ...email(
        "deadline",
        `${entry.id}:${phase}:${deadline}`,
        s.participants
          .filter((p) => awaitsAnswer(s, p.personId))
          .map((p): Recipient => {
            if (phase === "feedback") return [p.personId, message(entry, "Reminder: feedback due", `Your feedback is requested ${byEnd}.`, { deadline: due })];
            if (s.reversibility === "two_way") {
              return [p.personId, message(entry, "Reminder: Go or objection due", `Please answer with a Go or an objection ${byEnd}.`, { deadline: due })];
            }
            return [
              p.personId,
              message(entry, "Reminder: your Go is due", `Your Go on version ${s.currentVersion} is needed ${byEnd}. You can also raise an objection.`, { deadline: due }),
            ];
          }),
      ),
    );
  }

  // Feedback deadline passed, objection round not started: after 1 working day, then every 2, at most 3 times.
  if (s.status === "feedback") {
    const n = scheduled(s.feedbackDeadline, today, [1, 3, 5]);
    if (n) {
      planned.push(
        ...email("start_round", `${entry.id}:${s.feedbackDeadline}:${n}`, [
          [
            s.proposerId,
            message(
              entry,
              "Reminder: start the objection round",
              `The feedback deadline passed on ${dateToken(s.feedbackDeadline)}. Start the objection round, or extend the deadline.`,
            ),
          ],
        ]),
      );
    }
  }

  if (s.status === "objection_round" && s.objectionDeadline) {
    const ready = readiness(s, ctx.now);
    // One-way, deadline passed, still blocked: daily, at most 5 times.
    if (s.reversibility === "one_way" && !ready.ready) {
      const n = scheduled(s.objectionDeadline, today, [1, 2, 3, 4, 5]);
      if (n) {
        const missing = ready.criteria.filter((c) => !c.ok).map((c) => c.label);
        const text = `The objection period ended on ${dateToken(s.objectionDeadline)}, but the decision is blocked. Still open: ${missing.join("; ")}.`;
        planned.push(
          ...email("blocked", `${entry.id}:${s.objectionDeadline}:${n}`, [
            [s.proposerId, message(entry, "Reminder: decision blocked", text)],
            [s.deciderId, message(entry, "Reminder: decision blocked", text)],
          ]),
        );
      }
    }
    // Ready but not published: after 2 working days, then every 2, at most 3 times.
    if (ready.ready && ctx.readySince) {
      const readyOn = serverDate(ctx.readySince);
      const n = scheduled(readyOn, today, [2, 4, 6]);
      if (n) {
        planned.push(
          ...email("ready", `${entry.id}:${ctx.readySince.toISOString()}:${n}`, [
            [
              s.deciderId,
              message(
                entry,
                "Reminder: ready to decide",
                `This proposal has been ready to decide since ${dateToken(readyOn)}. Publish the decision, or reject the proposal.`,
                { path: `/e/${refOf(entry)}/decide` },
              ),
            ],
          ]),
        );
      }
    }
  }
  return planned;
}

export interface ReviewContext {
  entry: EntryInfo;
  /** The decision's entry status: logged decisions are published, decided proposals decided. */
  status: string;
  /** Set once another decision replaced this one. */
  supersededById: string | null;
  deciderId: string;
  authorId: string;
  reviewDate: string;
  today: string;
}

/**
 * The review date of a decision in force (logged or decided, and not
 * replaced): from the first working day on or after it, the decider and the
 * author are asked by email to check whether the decision works. A reminder
 * not yet sent (for example when the decision was published after its review
 * date) goes out on the next working day; the delivery key keeps it to one.
 */
export function planReviewReminder(ctx: ReviewContext): PlannedDelivery[] {
  const { entry, reviewDate, today } = ctx;
  const inForce = (ctx.status === "published" || ctx.status === "decided") && ctx.supersededById === null;
  if (!inForce) return [];
  const due = isWorkingDay(reviewDate) ? reviewDate : addWorkingDays(reviewDate, 1);
  if (!isWorkingDay(today) || today < due) return [];
  const msg = message(
    entry,
    "Reminder: review the decision",
    `The review date of this decision has come (${dateToken(reviewDate)}). Check whether it works: the decider can record the result as an addendum, and anyone can propose a change that replaces it.`,
  );
  return deliveries(entry.id, "reminder.review", `${entry.id}:${reviewDate}`, "email", [
    [ctx.deciderId, msg],
    [ctx.authorId, msg],
  ]);
}

// ---------------------------------------------------------------------------
// The Logbuch Slack channel
// ---------------------------------------------------------------------------

export type ChannelEvent = "submitted" | "decided" | "rejected" | EntryType;

/**
 * One post per entry and event to the Logbuch Slack channel, with the
 * summary, impact, and affected teams. Never the proposal text.
 */
function channelPost(entry: EntryInfo, post: PostInfo, event: ChannelEvent, msg: NotificationMessage): PlannedDelivery {
  const content: ChannelPost = {
    type: TYPE_LABELS[post.type],
    summary: post.summary,
    impact: post.impact ? IMPACT_LABELS[post.impact] : NOT_SET,
    mustRead: post.impact === "large",
    affectedTeams: post.affectedTeams,
  };
  return {
    key: `channel.${event}:${entry.id}`,
    event: `channel.${event}`,
    entryId: entry.id,
    recipientId: null,
    channel: "slack_channel",
    message: { ...msg, post: content },
  };
}

const POSTED: Record<EntryType, [subject: string, verb: string]> = {
  update: ["New update", "posted an update"],
  learning: ["New learning", "shared a learning"],
  decision: ["Decision logged", "logged a decision"],
};

/** The channel post for an update, learning, or decision logged directly. */
export function planEntryPost(entry: EntryInfo, post: PostInfo, actorName: string): PlannedDelivery {
  const [subject, verb] = POSTED[post.type];
  return channelPost(entry, post, post.type, message(entry, subject, `${actorName} ${verb}.`));
}
