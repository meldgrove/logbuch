import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Database, Transaction } from "@/lib/db/client";
import { entry, webhookState } from "@/lib/db/schema";
import { errorMessage, logger } from "@/lib/logger";
import type { WebhookClient } from "./client";
import { loadEntryFacts } from "./facts";
import { toWebhookPayload, type WebhookPayload } from "./payload";

/*
 * Keeps the webhook receiver in step with Logbuch. Commands call
 * `requestWebhook` in their transaction (publish, edit, impact change,
 * addendum, supersede, decision). The worker sends requested entries every
 * minute and, every night, re-sends every entry whose payload changed.
 */

/** Waits after the 1st, 2nd, 3rd, and later failed attempts. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/** Marks an entry for sending. Call it inside the command's transaction. */
export async function requestWebhook(tx: Database | Transaction, entryId: string, now: Date): Promise<void> {
  await tx
    .insert(webhookState)
    .values({ entryId, requestedAt: now })
    .onConflictDoUpdate({ target: webhookState.entryId, set: { requestedAt: now, attempts: 0, nextAttemptAt: null } });
}

/** A stable hash of the payload: JSON with sorted keys. */
export function payloadHash(payload: WebhookPayload): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, stable(v)]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}

export type SyncOutcome = "sent" | "unchanged" | "not_sent" | "failed" | "busy";

/**
 * How long a run owns an entry it is sending. Leases are set and compared on
 * the database clock at the moment of each claim, never on a worker's clock or
 * a job's start time. The lease is renewed right before the request; from
 * then on the client's timeout (30 seconds) ends the send well before the
 * lease does, so no other run can take over while a request can still land.
 */
export const LEASE_SECONDS = 300;
const leaseExpiry = sql`clock_timestamp() + ${sql.raw(`interval '${LEASE_SECONDS} seconds'`)}`;

/** Due: requested, past any retry pause, and not being sent by another run. */
const isDue = (now: Date) =>
  and(
    isNotNull(webhookState.requestedAt),
    or(isNull(webhookState.nextAttemptAt), lte(webhookState.nextAttemptAt, now)),
    or(isNull(webhookState.leaseUntil), lt(webhookState.leaseUntil, sql`clock_timestamp()`)),
  );

/**
 * Sends one requested entry. The run first claims the entry with a lease in a
 * single statement, so no two runs send it at the same time; no transaction
 * is open while the receiver answers, so writes in Logbuch never wait for it.
 * Completion updates apply only while this run still owns the lease, and the
 * request is cleared, or a failure counted, only if no newer request arrived
 * meanwhile: a newer request keeps its immediate, fresh retry state.
 */
async function syncOne(db: Database, client: WebhookClient, baseUrl: string, entryId: string, now: Date): Promise<SyncOutcome> {
  const owner = randomUUID();
  const [claimed] = await db
    .update(webhookState)
    .set({ leaseOwner: owner, leaseUntil: leaseExpiry })
    .where(and(eq(webhookState.entryId, entryId), isDue(now)))
    .returning();
  if (!claimed?.requestedAt) return "busy";

  const sameRequest = sql`${webhookState.requestedAt} = ${claimed.requestedAt.toISOString()}::timestamptz`;
  const clearIfSame = sql`case when ${sameRequest} then null else ${webhookState.requestedAt} end`;
  const finish = (values: PgUpdateSetSource<typeof webhookState>) =>
    db
      .update(webhookState)
      .set({ ...values, leaseOwner: null, leaseUntil: null })
      .where(and(eq(webhookState.entryId, entryId), eq(webhookState.leaseOwner, owner)));

  try {
    const facts = await loadEntryFacts(db, entryId);
    const payload = facts ? toWebhookPayload(facts, baseUrl) : null;
    if (!payload) {
      // Open or withdrawn proposals are not sent.
      await finish({ requestedAt: clearIfSame, attempts: 0, nextAttemptAt: null, lastError: null });
      return "not_sent";
    }
    const hash = payloadHash(payload);
    if (hash === claimed.payloadHash) {
      await finish({ requestedAt: clearIfSame, attempts: 0, nextAttemptAt: null, lastError: null });
      return "unchanged";
    }
    // Loading may have been slow: renew the lease, and stop if it was lost.
    const [kept] = await db
      .update(webhookState)
      .set({ leaseUntil: leaseExpiry })
      .where(and(eq(webhookState.entryId, entryId), eq(webhookState.leaseOwner, owner)))
      .returning({ entryId: webhookState.entryId });
    if (!kept) return "busy";
    await client.send(payload);
    // The receiver now has this payload. A newer request stays and is sent next.
    await finish({
      requestedAt: clearIfSame,
      payloadHash: hash,
      deliveredAt: now,
      attempts: sql`case when ${sameRequest} then 0 else ${webhookState.attempts} end`,
      nextAttemptAt: sql`case when ${sameRequest} then null else ${webhookState.nextAttemptAt} end`,
      lastError: null,
    });
    return "sent";
  } catch (error) {
    const attempts = claimed.attempts + 1;
    const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;
    const message = errorMessage(error).slice(0, 1_000);
    await finish({
      attempts: sql`case when ${sameRequest} then ${attempts} else ${webhookState.attempts} end`,
      nextAttemptAt: sql`case when ${sameRequest} then ${new Date(now.getTime() + wait).toISOString()}::timestamptz else ${webhookState.nextAttemptAt} end`,
      lastError: message,
    });
    logger.warn({ entryId, attempts, error: message }, "webhook failed; will retry");
    return "failed";
  }
}

/** Sends requested entries that are due. Returns what happened to each. */
export async function syncRequested(
  db: Database,
  client: WebhookClient,
  baseUrl: string,
  now: Date,
  limit = 100,
): Promise<Record<SyncOutcome, number>> {
  const counts: Record<SyncOutcome, number> = { sent: 0, unchanged: 0, not_sent: 0, failed: 0, busy: 0 };
  const due = await db
    .select({ entryId: webhookState.entryId })
    .from(webhookState)
    .where(isDue(now))
    .orderBy(asc(webhookState.requestedAt))
    .limit(limit);
  for (const { entryId } of due) counts[await syncOne(db, client, baseUrl, entryId, now)] += 1;
  return counts;
}

/**
 * The nightly correction: requests every sendable entry whose payload differs
 * from what the receiver last got (including entries never sent), then sends
 * them. The first run after the webhook is configured sends everything.
 */
export async function reconcileWebhook(db: Database, client: WebhookClient, baseUrl: string, now: Date) {
  const entries = await db
    .select({ id: entry.id, hash: webhookState.payloadHash, requestedAt: webhookState.requestedAt })
    .from(entry)
    .leftJoin(webhookState, eq(webhookState.entryId, entry.id))
    // Published entries (updates, learnings, logged decisions) and decided or
    // rejected proposals; toWebhookPayload decides the rest.
    .where(inArray(entry.status, ["published", "decided", "rejected"]))
    .orderBy(asc(entry.number));
  let requested = 0;
  for (const row of entries) {
    if (row.requestedAt) continue;
    const facts = await loadEntryFacts(db, row.id);
    const payload = facts ? toWebhookPayload(facts, baseUrl) : null;
    if (payload && payloadHash(payload) !== row.hash) {
      await requestWebhook(db, row.id, now);
      requested += 1;
    }
  }
  const counts = await syncRequested(db, client, baseUrl, now, Number.MAX_SAFE_INTEGER);
  return { requested, ...counts };
}
