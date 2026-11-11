import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ENTRY_TYPES,
  HOW_DECIDED,
  IMPACTS,
  REVERSIBILITIES,
  type EntryType,
  type HowDecided,
  type Impact,
  type Reversibility,
} from "@/lib/entries/constants";
import type { NotificationChannels, NotificationMessage } from "@/lib/notifications/types";
import type { DateFormat } from "@/lib/preferences";

/*
 * Database schema. Migrations are generated from this file with
 * `npm run db:generate` and live in `drizzle/`.
 *
 * No row in the Logbuch tables is ever deleted. People who lose access keep
 * their row with `has_access = false`. Better Auth may delete sessions.
 * Database triggers enforce this (drizzle/0001_no_deletion.sql): entries can
 * only be deleted as unsubmitted drafts, and the audit log is append-only.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const uuidv7PrimaryKey = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamptz("created_at").notNull().defaultNow();
const updatedAt = () => timestamptz("updated_at").notNull().defaultNow();

// ---------------------------------------------------------------------------
// Better Auth (models user, session, account, verification)
// ---------------------------------------------------------------------------

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamptz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    /**
     * The OIDC `sub` this session logged in with. One Better Auth user can
     * have several (Better Auth links a new `sub` with the same verified
     * email), so the person behind a session is found by this, not by the user.
     */
    oidcSubject: text("oidc_subject").notNull(),
  },
  (table) => [
    index("auth_session_user_id_idx").on(table.userId),
    index("auth_session_oidc_subject_idx").on(table.oidcSubject),
  ],
);

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    /** The OIDC `sub` of the user. */
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamptz("access_token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("auth_account_user_id_idx").on(table.userId),
    uniqueIndex("auth_account_provider_account_idx").on(table.providerId, table.accountId),
  ],
);

export const authVerification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("auth_verification_identifier_idx").on(table.identifier)],
);

// ---------------------------------------------------------------------------
// People and teams: managed in Logbuch (manual directory) or synced from
// Keycloak (keycloak directory)
// ---------------------------------------------------------------------------

export const team = pgTable("team", {
  id: uuidv7PrimaryKey(),
  /** ID of the team in the external directory (the Keycloak group ID); empty for teams managed in Logbuch. */
  externalId: text("external_id").unique(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const person = pgTable(
  "person",
  {
    id: uuidv7PrimaryKey(),
    /** ID of the person in the external directory (the Keycloak user ID); empty for people managed in Logbuch. */
    externalId: text("external_id").unique(),
    /**
     * The OIDC `sub`. Links the person to Better Auth's account row. Empty for
     * an invited person until their first login.
     */
    oidcSubject: text("oidc_subject").unique(),
    displayName: text("display_name").notNull(),
    workEmail: text("work_email"),
    teamId: uuid("team_id").references(() => team.id),
    hasAccess: boolean("has_access").notNull().default(false),
    isAdmin: boolean("is_admin").notNull().default(false),
    /** When `has_access` last changed. */
    accessChangedAt: timestamptz("access_changed_at").notNull().defaultNow(),
    /** Last directory sync that listed the person; empty for people managed in Logbuch. */
    lastSeenInDirectoryAt: timestamptz("last_seen_in_directory_at"),
    /** IANA time zone for dates and times; empty means the server's time zone. */
    timeZone: text("time_zone"),
    /** How dates are written; empty means the default (DD.MM.YYYY). */
    dateFormat: text("date_format").$type<DateFormat>(),
    /** Slack user ID, looked up by `work_email` and cached. */
    slackUserId: text("slack_user_id"),
    /** Set when no Slack user was found; the lookup is retried after a week. */
    slackLookupFailedAt: timestamptz("slack_lookup_failed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("person_has_access_idx").on(table.hasAccess),
    index("person_work_email_lower_idx").on(sql`lower(${table.workEmail})`),
  ],
);

/**
 * Months in which a person opened Logbuch, for the "monthly active users"
 * statistic. One row per person and month, nothing finer.
 */
export const personActiveMonth = pgTable(
  "person_active_month",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id),
    /** The first day of the month in the server's time zone. */
    month: date("month").notNull(),
  },
  (table) => [primaryKey({ columns: [table.personId, table.month] })],
);

export const directorySyncRun = pgTable(
  "directory_sync_run",
  {
    id: uuidv7PrimaryKey(),
    /** What started the run: schedule, startup, login, admin, or manual. */
    trigger: text("trigger").notNull(),
    /** running, succeeded, or failed. */
    status: text("status").notNull(),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
    peopleReceived: integer("people_received"),
    teamsReceived: integer("teams_received"),
    accessGranted: integer("access_granted"),
    accessRemoved: integer("access_removed"),
    sessionsEnded: integer("sessions_ended"),
    error: text("error"),
  },
  (table) => [index("directory_sync_run_started_at_idx").on(table.startedAt)],
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const workerHeartbeat = pgTable("worker_heartbeat", {
  workerId: text("worker_id").primaryKey(),
  startedAt: timestamptz("started_at").notNull(),
  beatAt: timestamptz("beat_at").notNull(),
  /** How the worker sends notifications, shown on the admin page. */
  channels: jsonb("channels").$type<NotificationChannels>(),
});

// ---------------------------------------------------------------------------
// Entries: updates, decisions, and learnings. A proposal is a decision with a
// `proposal` row; it is a decision in progress.
// ---------------------------------------------------------------------------

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export { ENTRY_TYPES, REVERSIBILITIES, type EntryType, type Reversibility };

export const ENTRY_STATUSES = [
  "draft",
  "feedback",
  "objection_round",
  "decided",
  "rejected",
  "withdrawn",
  "published",
] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export interface EntryLink {
  url: string;
}

const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const tag = pgTable(
  "tag",
  {
    id: uuidv7PrimaryKey(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("tag_name_lower_idx").on(sql`lower(${table.name})`)],
);

export const entry = pgTable(
  "entry",
  {
    id: uuidv7PrimaryKey(),
    /** Shown as LB-<number>. */
    number: integer("number").notNull().unique().generatedAlwaysAsIdentity(),
    type: text("type").$type<EntryType>().notNull(),
    status: text("status").$type<EntryStatus>().notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    /** Details; for decisions the context (a proposal's tension). */
    body: text("body").notNull().default(""),
    /** Why. Required for decisions; for a proposal set when it is decided, rejected, or withdrawn. */
    rationale: text("rationale").notNull().default(""),
    /** Who needs to know. Empty only for imported entries without an impact. */
    impact: text("impact").$type<Impact>(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => person.id),
    links: jsonb("links").$type<EntryLink[]>().notNull().default(sql`'[]'::jsonb`),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => entry.id),
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => entry.id),
    personalDataConfirmedAt: timestamptz("personal_data_confirmed_at"),
    /** Details, rationale, question, proposal and decision text, and addenda, kept by the entries module for search. */
    searchText: text("search_text").notNull().default(""),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(summary, '')), 'B') || setweight(to_tsvector('simple', coalesce(summary, '')), 'B') || setweight(to_tsvector('english', coalesce(search_text, '')), 'C') || setweight(to_tsvector('simple', coalesce(search_text, '')), 'C')`,
    ),
    createdAt: createdAt(),
    submittedAt: timestamptz("submitted_at"),
    publishedAt: timestamptz("published_at"),
    /** Last edit of a published update or learning; shown as "edited". */
    editedAt: timestamptz("edited_at"),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("entry_published_at_idx").on(table.publishedAt.desc()),
    index("entry_team_id_idx").on(table.teamId),
    index("entry_author_id_idx").on(table.authorId),
    index("entry_search_vector_idx").using("gin", table.searchVector),
    check("entry_type_check", sql`${table.type} in (${sqlList(ENTRY_TYPES)})`),
    check("entry_status_check", sql`${table.status} in (${sqlList(ENTRY_STATUSES)})`),
    check("entry_impact_check", sql`${table.impact} is null or ${table.impact} in (${sqlList(IMPACTS)})`),
  ],
);

/** Teams an entry affects, besides its owning team. */
export const entryAffectedTeam = pgTable(
  "entry_affected_team",
  {
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entry.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id),
  },
  (table) => [primaryKey({ columns: [table.entryId, table.teamId] })],
);

export const entryTag = pgTable(
  "entry_tag",
  {
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entry.id),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tag.id),
  },
  (table) => [primaryKey({ columns: [table.entryId, table.tagId] }), index("entry_tag_tag_id_idx").on(table.tagId)],
);

export const entryRelation = pgTable(
  "entry_relation",
  {
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entry.id),
    relatedEntryId: uuid("related_entry_id")
      .notNull()
      .references(() => entry.id),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.relatedEntryId] }),
    check("entry_relation_not_self", sql`${table.entryId} <> ${table.relatedEntryId}`),
  ],
);

export const PARTICIPANT_ROLES = ["involved", "consent_giver", "feedback_giver"] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const participant = pgTable(
  "participant",
  {
    id: uuidv7PrimaryKey(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entry.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id),
    role: text("role").$type<ParticipantRole>().notNull(),
    addedById: uuid("added_by_id")
      .notNull()
      .references(() => person.id),
    addedAt: timestamptz("added_at").notNull().defaultNow(),
    removedAt: timestamptz("removed_at"),
    removedById: uuid("removed_by_id").references(() => person.id),
    removalReason: text("removal_reason"),
  },
  (table) => [
    uniqueIndex("participant_active_role_idx")
      .on(table.entryId, table.personId, table.role)
      .where(sql`${table.removedAt} is null`),
    index("participant_person_id_idx").on(table.personId),
    check("participant_role_check", sql`${table.role} in (${sqlList(PARTICIPANT_ROLES)})`),
  ],
);

export const OUTCOME_RESULTS = ["adopted", "rejected", "withdrawn", "recorded"] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];


/**
 * The result of a decision: `recorded` for a logged decision, otherwise how a
 * proposal ended. The rationale is on the entry.
 */
export const outcome = pgTable(
  "outcome",
  {
    entryId: uuid("entry_id")
      .primaryKey()
      .references(() => entry.id),
    result: text("result").$type<OutcomeResult>().notNull(),
    /** The decision text; empty for a rejected or withdrawn proposal. */
    finalText: text("final_text").notNull(),
    objectionHandling: text("objection_handling"),
    decidedById: uuid("decided_by_id")
      .notNull()
      .references(() => person.id),
    decidedOn: date("decided_on").notNull(),
    personalDataConfirmedAt: timestamptz("personal_data_confirmed_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [check("outcome_result_check", sql`${table.result} in (${sqlList(OUTCOME_RESULTS)})`)],
);

/**
 * The fields of every decision, logged or from a proposal. A proposal has its
 * row from the first draft.
 */
export const decision = pgTable(
  "decision",
  {
    entryId: uuid("entry_id")
      .primaryKey()
      .references(() => entry.id),
    /** Empty only for imported decisions without a reversibility; counts as two-way. */
    reversibility: text("reversibility").$type<Reversibility>(),
    /** Why a one-way decision is hard to reverse. */
    reversibilityReason: text("reversibility_reason"),
    deciderId: uuid("decider_id")
      .notNull()
      .references(() => person.id),
    howDecided: text("how_decided").$type<HowDecided>().notNull(),
    effectiveDate: date("effective_date"),
    reviewDate: date("review_date"),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("decision_reversibility_check", sql`${table.reversibility} is null or ${table.reversibility} in (${sqlList(REVERSIBILITIES)})`),
    check("decision_how_decided_check", sql`${table.howDecided} in (${sqlList(HOW_DECIDED)})`),
  ],
);

/** Full snapshot of an update or learning after each save; revision 1 is the original. */
export const entryRevision = pgTable(
  "entry_revision",
  {
    id: uuidv7PrimaryKey(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entry.id),
    revision: integer("revision").notNull(),
    type: text("type").$type<EntryType>().notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    body: text("body").notNull(),
    rationale: text("rationale").notNull(),
    /** Empty only for imported entries without an impact. */
    impact: text("impact").$type<Impact>(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id),
    tagIds: jsonb("tag_ids").$type<string[]>().notNull(),
    affectedTeamIds: jsonb("affected_team_ids").$type<string[]>().notNull(),
    links: jsonb("links").$type<EntryLink[]>().notNull(),
    relatedEntryIds: jsonb("related_entry_ids").$type<string[]>().notNull(),
    editedById: uuid("edited_by_id")
      .notNull()
      .references(() => person.id),
    personalDataConfirmedAt: timestamptz("personal_data_confirmed_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("entry_revision_entry_revision_idx").on(table.entryId, table.revision)],
);

export const addendum = pgTable(
  "addendum",
  {
    id: uuidv7PrimaryKey(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entry.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => person.id),
    text: text("text").notNull(),
    personalDataConfirmedAt: timestamptz("personal_data_confirmed_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("addendum_entry_id_idx").on(table.entryId)],
);

/** Append-only (enforced by a trigger). */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuidv7PrimaryKey(),
    actorId: uuid("actor_id").references(() => person.id),
    action: text("action").notNull(),
    entryId: uuid("entry_id").references(() => entry.id),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (table) => [index("audit_event_entry_id_idx").on(table.entryId, table.createdAt)],
);

/** Fixed-window counters for per-person write limits. */
export const rateLimit = pgTable(
  "rate_limit",
  {
    key: text("key").notNull(),
    windowStart: timestamptz("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.key, table.windowStart] })],
);

// ---------------------------------------------------------------------------
// Proposals and the decision process
// ---------------------------------------------------------------------------

/**
 * The process state of a proposal. Its reversibility and decider are in
 * `decision`, its context in `entry.body`.
 */
export const proposal = pgTable(
  "proposal",
  {
    entryId: uuid("entry_id")
      .primaryKey()
      .references(() => entry.id),
    question: text("question").notNull(),
    feedbackDeadline: date("feedback_deadline").notNull(),
    objectionPeriodDays: integer("objection_period_days").notNull(),
    objectionRoundStartedAt: timestamptz("objection_round_started_at"),
    /** Set when the objection round starts. */
    objectionDeadline: date("objection_deadline"),
    currentVersion: integer("current_version").notNull().default(1),
    /** Set when the proposal becomes one-way; Gos given before it do not count as consent. */
    goResetAt: timestamptz("go_reset_at"),
    /**
     * When the proposal last became ready to decide; empty while it is not.
     * Each time it becomes ready, the decider is told once and the reminder
     * clock starts again.
     */
    readySince: timestamptz("ready_since"),
    updatedAt: updatedAt(),
  },
  (table) => [check("proposal_objection_period_check", sql`${table.objectionPeriodDays} >= 1`)],
);

export const proposalVersion = pgTable(
  "proposal_version",
  {
    id: uuidv7PrimaryKey(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entry.id),
    number: integer("number").notNull(),
    text: text("text").notNull(),
    changeNote: text("change_note"),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => person.id),
    /** Null only while the proposal is an unsubmitted draft. */
    personalDataConfirmedAt: timestamptz("personal_data_confirmed_at"),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("proposal_version_entry_number_idx").on(table.entryId, table.number)],
);

export const RESPONSE_KINDS = ["question", "answer", "feedback", "go", "objection"] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];

/** Questions, answers, feedback, Go, and objections on a proposal. */
export const response = pgTable(
  "response",
  {
    id: uuidv7PrimaryKey(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entry.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id),
    kind: text("kind").$type<ResponseKind>().notNull(),
    /** The proposal version the response refers to. A Go counts only for its version. */
    versionId: uuid("version_id")
      .notNull()
      .references(() => proposalVersion.id),
    text: text("text").notNull().default(""),
    /** An answer points to its question. */
    parentId: uuid("parent_id").references((): AnyPgColumn => response.id),
    resolvedAt: timestamptz("resolved_at"),
    resolvedById: uuid("resolved_by_id").references(() => person.id),
    resolutionNote: text("resolution_note"),
    withdrawnAt: timestamptz("withdrawn_at"),
    createdAt: createdAt(),
  },
  (table) => [
    index("response_entry_id_idx").on(table.entryId, table.createdAt),
    index("response_person_id_idx").on(table.personId),
    check("response_kind_check", sql`${table.kind} in (${sqlList(RESPONSE_KINDS)})`),
  ],
);

/** Admin settings, e.g. the default periods of the decision process. */
export const appSetting = pgTable("app_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedById: uuid("updated_by_id").references(() => person.id),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** `slack_channel`: a post to the Logbuch Slack channel, with no recipient person. */
export const NOTIFICATION_CHANNELS = ["slack", "email", "slack_channel"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const DELIVERY_STATUSES = ["pending", "sent", "skipped", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * One message to one person on one channel. Commands insert rows in their own
 * transaction; only the worker sends them. `delivery_key` is unique, so a
 * notification is recorded, and sent, at most once.
 */
export const notificationDelivery = pgTable(
  "notification_delivery",
  {
    id: uuidv7PrimaryKey(),
    deliveryKey: text("delivery_key").notNull().unique(),
    event: text("event").notNull(),
    entryId: uuid("entry_id").references(() => entry.id),
    /** Empty exactly for posts to the Logbuch Slack channel. */
    recipientId: uuid("recipient_id").references(() => person.id),
    channel: text("channel").$type<NotificationChannel>().notNull(),
    status: text("status").$type<DeliveryStatus>().notNull().default("pending"),
    /** Title, action, deadline, and link. Never the proposal text. */
    message: jsonb("message").$type<NotificationMessage>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    createdAt: createdAt(),
    sentAt: timestamptz("sent_at"),
    /** The last error, or why the message was skipped. */
    lastError: text("last_error"),
  },
  (table) => [
    index("notification_delivery_pending_idx").on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
    index("notification_delivery_entry_id_idx").on(table.entryId),
    index("notification_delivery_status_idx").on(table.status, table.createdAt),
    check("notification_delivery_channel_check", sql`${table.channel} in (${sqlList(NOTIFICATION_CHANNELS)})`),
    check("notification_delivery_status_check", sql`${table.status} in (${sqlList(DELIVERY_STATUSES)})`),
    check(
      "notification_delivery_recipient_check",
      sql`(${table.channel} = 'slack_channel') = (${table.recipientId} is null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/**
 * Delivery state of one entry for the webhook. Commands set `requested_at` in
 * their transaction; the worker posts the entry and clears it. `payload_hash`
 * lets the nightly run re-send only entries whose content changed.
 */
export const webhookState = pgTable(
  "webhook_state",
  {
    entryId: uuid("entry_id")
      .primaryKey()
      .references(() => entry.id),
    requestedAt: timestamptz("requested_at"),
    payloadHash: text("payload_hash"),
    deliveredAt: timestamptz("delivered_at"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at"),
    lastError: text("last_error"),
    /** The worker run that is sending this entry, so runs never send it at the same time. */
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamptz("lease_until"),
  },
  (table) => [index("webhook_state_requested_idx").on(table.requestedAt).where(sql`${table.requestedAt} is not null`)],
);

/**
 * Where an imported entry came from (the CSV import). The key (source,
 * external ID) is unique, so an import never creates an entry
 * twice, even when it runs again or twice at once.
 */
export const entryImport = pgTable(
  "entry_import",
  {
    source: text("source").notNull(),
    /** The row's `id` in the import file (for example the ID in the old system). */
    externalId: text("external_id").notNull(),
    entryId: uuid("entry_id")
      .notNull()
      .unique()
      .references(() => entry.id),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.source, table.externalId] })],
);
