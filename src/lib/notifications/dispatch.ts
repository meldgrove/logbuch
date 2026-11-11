import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { Database, Transaction } from "@/lib/db/client";
import { notificationDelivery, person, type NotificationChannel } from "@/lib/db/schema";
import { createDateFormatter, defaultFormatter } from "@/lib/format";
import { errorMessage, logger } from "@/lib/logger";
import { emailContent, slackText } from "./format-message";
import { displayPreferences } from "@/lib/preferences";
import { DeliveryError, type SlackTransport, type Transports } from "./transports";

/*
 * The worker's sender. It claims one due delivery at a time with
 * FOR UPDATE SKIP LOCKED and holds the lock while sending, so two workers never
 * send the same delivery. A delivery ends as sent, skipped (no channel
 * reaches the person, no access), or failed after 5 attempts. Events prefer
 * Slack and reminders prefer email. The message goes out on the other channel
 * when the preferred one is off, cannot reach the person, or fails with a
 * permanent error, and on the last attempt after any error.
 */

export const MAX_ATTEMPTS = 5;
/** Waits after the 1st, 2nd, 3rd, and 4th failed attempt. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** A failed Slack lookup is retried after a week. */
export const SLACK_LOOKUP_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Slack errors that mean the cached user ID is stale. */
const STALE_SLACK_USER = new Set(["channel_not_found", "user_not_found", "account_inactive", "user_disabled"]);

export type DispatchOutcome = "sent" | "skipped" | "retry" | "failed";

class Skip {
  constructor(readonly reason: string) {}
}

type Recipient = Pick<
  typeof person.$inferSelect,
  "id" | "displayName" | "workEmail" | "hasAccess" | "slackUserId" | "slackLookupFailedAt" | "timeZone" | "dateFormat"
>;
type LookupState = Pick<Recipient, "id" | "workEmail" | "slackLookupFailedAt">;

/**
 * Saves a Slack lookup result, but only while the person's work email and
 * lookup state are what the lookup started from: a directory sync that
 * changed the email meanwhile has cleared the cache, and wins. Returns false
 * when the result was discarded.
 */
async function saveSlackLookup(db: Database | Transaction, before: LookupState, userId: string | null, now: Date): Promise<boolean> {
  const saved = await db
    .update(person)
    .set(userId ? { slackUserId: userId, slackLookupFailedAt: null } : { slackLookupFailedAt: now })
    .where(
      and(
        eq(person.id, before.id),
        before.workEmail === null ? isNull(person.workEmail) : eq(person.workEmail, before.workEmail),
        isNull(person.slackUserId),
        before.slackLookupFailedAt === null ? isNull(person.slackLookupFailedAt) : eq(person.slackLookupFailedAt, before.slackLookupFailedAt),
      ),
    )
    .returning({ id: person.id });
  return saved.length > 0;
}

async function slackUserIdFor(tx: Transaction, recipient: Recipient, slack: SlackTransport, now: Date): Promise<string | Skip> {
  if (slack.mode === "console") return `console:${recipient.id}`;
  if (recipient.slackUserId) return recipient.slackUserId;
  if (recipient.slackLookupFailedAt && now.getTime() - recipient.slackLookupFailedAt.getTime() < SLACK_LOOKUP_RETRY_MS) {
    return new Skip("No Slack account was found for this person's work email.");
  }
  const userId = recipient.workEmail ? await slack.lookupUserByEmail(recipient.workEmail) : null;
  if (!(await saveSlackLookup(tx, recipient, userId, now))) {
    throw new DeliveryError("The work email changed during the Slack lookup; the next attempt uses the new one.");
  }
  return userId ?? new Skip("No Slack account was found for this person's work email.");
}

/** Sends one due delivery, if there is one. Returns null when nothing is due. */
export async function dispatchNext(db: Database, transports: Transports, now: Date): Promise<DispatchOutcome | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        delivery: notificationDelivery,
        recipient: {
          id: person.id,
          displayName: person.displayName,
          workEmail: person.workEmail,
          hasAccess: person.hasAccess,
          slackUserId: person.slackUserId,
          slackLookupFailedAt: person.slackLookupFailedAt,
          timeZone: person.timeZone,
          dateFormat: person.dateFormat,
        },
      })
      .from(notificationDelivery)
      // Posts to the Slack channel have no recipient person.
      .leftJoin(person, eq(person.id, notificationDelivery.recipientId))
      .where(and(eq(notificationDelivery.status, "pending"), lte(notificationDelivery.nextAttemptAt, now)))
      .orderBy(asc(notificationDelivery.nextAttemptAt))
      .limit(1)
      .for("update", { of: notificationDelivery, skipLocked: true });
    if (!row) return null;
    const { delivery, recipient } = row;
    const attempts = delivery.attempts + 1;
    const update = (values: Partial<typeof notificationDelivery.$inferInsert>) =>
      tx.update(notificationDelivery).set(values).where(eq(notificationDelivery.id, delivery.id));

    try {
      const result = await send(tx, delivery, recipient, transports, now, attempts >= MAX_ATTEMPTS);
      if (result instanceof Skip) {
        await update({ status: "skipped", attempts, lastError: result.reason });
        return "skipped";
      }
      // `channel` records how the message went out, e.g. email instead of Slack,
      // and `lastError` why the preferred channel failed, if it did.
      await update({ status: "sent", channel: result.channel, attempts, sentAt: now, lastError: result.fallbackReason?.slice(0, 1_000) ?? null });
      return "sent";
    } catch (error) {
      const message = errorMessage(error).slice(0, 1_000);
      if (attempts >= MAX_ATTEMPTS) {
        await update({ status: "failed", attempts, lastError: message });
        logger.error({ deliveryId: delivery.id, channel: delivery.channel, error: message }, "notification failed");
        return "failed";
      }
      const backoff = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS.at(-1)!;
      const wait = Math.max(backoff, error instanceof DeliveryError ? (error.retryAfterMs ?? 0) : 0);
      await update({ attempts, lastError: message, nextAttemptAt: new Date(now.getTime() + wait) });
      logger.warn({ deliveryId: delivery.id, channel: delivery.channel, attempts, error: message }, "notification will be retried");
      return "retry";
    }
  });
}

interface Sent {
  channel: NotificationChannel;
  /** Why the preferred channel failed, when the message went out on the other one after an error. */
  fallbackReason?: string;
}

/** Ends a reason with a full stop, so several read as sentences. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Sends a delivery. Returns the channel it went out on, or why it was skipped.
 * Throws when it should be tried again.
 */
async function send(
  tx: Transaction,
  delivery: typeof notificationDelivery.$inferSelect,
  recipient: Recipient | null,
  transports: Transports,
  now: Date,
  lastAttempt: boolean,
): Promise<Skip | Sent> {
  if (delivery.channel === "slack_channel") {
    if (!transports.slack) return new Skip("Slack is not configured.");
    if (!transports.slackChannelId) return new Skip("No Slack channel is configured (SLACK_CHANNEL_ID).");
    await transports.slack.postMessage(transports.slackChannelId, slackText(delivery.message, transports.baseUrl, defaultFormatter));
    return { channel: "slack_channel" };
  }
  if (!recipient) return new Skip("The recipient no longer exists.");
  if (!recipient.hasAccess) return new Skip("The recipient no longer has access.");
  const formatter = createDateFormatter(displayPreferences(recipient));

  async function viaSlack(): Promise<Skip | "slack"> {
    if (!transports.slack) return new Skip("Slack is not configured.");
    const userId = await slackUserIdFor(tx, recipient!, transports.slack, now);
    if (userId instanceof Skip) return userId;
    try {
      await transports.slack.postMessage(userId, slackText(delivery.message, transports.baseUrl, formatter));
    } catch (error) {
      // The next message looks the person up again.
      if (error instanceof DeliveryError && error.code && STALE_SLACK_USER.has(error.code)) {
        await tx.update(person).set({ slackUserId: null }).where(eq(person.id, recipient!.id));
      }
      throw error;
    }
    return "slack";
  }

  async function viaEmail(): Promise<Skip | "email"> {
    if (!transports.email) return new Skip("Email is not configured.");
    if (!recipient!.workEmail) return new Skip("The recipient has no email address.");
    await transports.email.send({
      to: recipient!.workEmail,
      toName: recipient!.displayName,
      ...emailContent(delivery.message, recipient!.displayName, transports.baseUrl, formatter),
    });
    return "email";
  }

  // The planned channel first. The other one when the planned one is off or
  // cannot reach the person, after a permanent error, and on the last attempt.
  // A temporary error otherwise means: try the planned channel again later.
  const channels = delivery.channel === "slack" ? [viaSlack, viaEmail] : [viaEmail, viaSlack];
  const reasons: string[] = [];
  const errors: unknown[] = [];
  for (const [index, channel] of channels.entries()) {
    try {
      const result = await channel();
      if (!(result instanceof Skip)) return { channel: result, fallbackReason: errors.length > 0 ? reasons.join(" ") : undefined };
      reasons.push(result.reason);
    } catch (error) {
      reasons.push(sentence(errorMessage(error)));
      const moveOn = index < channels.length - 1 && (lastAttempt || (error instanceof DeliveryError && error.permanent));
      if (!moveOn) throw reasons.length === 1 ? error : retryable(reasons, [...errors, error]);
      errors.push(error);
    }
  }
  // Both channels were tried: the planned one failed, the other cannot reach the person.
  if (errors.length > 0) throw retryable(reasons, errors);
  return new Skip(reasons.join(" "));
}

/** The error to retry with: it names what went wrong on each channel, and waits as long as any channel asked. */
function retryable(reasons: string[], errors: unknown[]): DeliveryError {
  const waits = errors.flatMap((error) => (error instanceof DeliveryError && error.retryAfterMs !== undefined ? [error.retryAfterMs] : []));
  return new DeliveryError(reasons.join(" "), { retryAfterMs: waits.length > 0 ? Math.max(...waits) : undefined });
}

/** Sends due deliveries until none is left or `limit` is reached. */
export async function dispatchDue(
  db: Database,
  transports: Transports,
  clock: () => Date = () => new Date(),
  limit = 50,
): Promise<Record<DispatchOutcome, number>> {
  const counts: Record<DispatchOutcome, number> = { sent: 0, skipped: 0, retry: 0, failed: 0 };
  for (let i = 0; i < limit; i += 1) {
    const outcome = await dispatchNext(db, transports, clock());
    if (!outcome) break;
    counts[outcome] += 1;
  }
  return counts;
}

/** Polls for due deliveries every `intervalMs`. Returns a function that stops and waits for the current run. */
export function startDispatcher(options: { db: Database; transports: Transports; intervalMs: number }): () => Promise<void> {
  let running: Promise<unknown> | undefined;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = dispatchDue(options.db, options.transports)
      .catch((error: unknown) => logger.error({ error: errorMessage(error) }, "notification dispatch failed"))
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, options.intervalMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

/**
 * Looks up Slack users again a week after a failed lookup, so people who join
 * Slack later get messages and leave the admin page list.
 * Runs with the worker's watch job. Returns the number of people found.
 */
export async function retrySlackLookups(db: Database, transports: Transports, now: Date): Promise<number> {
  const slack = transports.slack;
  if (!slack || slack.mode !== "live") return 0;
  const due = await db
    .select({ id: person.id, workEmail: person.workEmail, slackLookupFailedAt: person.slackLookupFailedAt })
    .from(person)
    .where(
      and(
        eq(person.hasAccess, true),
        isNull(person.slackUserId),
        lte(person.slackLookupFailedAt, new Date(now.getTime() - SLACK_LOOKUP_RETRY_MS)),
      ),
    );
  let found = 0;
  for (const p of due) {
    try {
      const userId = p.workEmail ? await slack.lookupUserByEmail(p.workEmail) : null;
      // A result for an email that changed meanwhile is dropped.
      if ((await saveSlackLookup(db, p, userId, now)) && userId) found += 1;
    } catch (error) {
      // Slack is unreachable or the token is wrong: try again on the next run.
      logger.warn({ personId: p.id, error: errorMessage(error) }, "Slack lookup failed");
    }
  }
  return found;
}
