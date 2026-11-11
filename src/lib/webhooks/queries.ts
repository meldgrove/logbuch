import { count, desc, eq, isNotNull, max } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { entry, webhookState } from "@/lib/db/schema";

/** What the admin page shows about the webhook. */
export async function getWebhookStatus(db: Database) {
  const [[synced], [waiting], [failingCount], [last], failing] = await Promise.all([
    db.select({ value: count() }).from(webhookState).where(isNotNull(webhookState.payloadHash)),
    db.select({ value: count() }).from(webhookState).where(isNotNull(webhookState.requestedAt)),
    db.select({ value: count() }).from(webhookState).where(isNotNull(webhookState.lastError)),
    db.select({ value: max(webhookState.deliveredAt) }).from(webhookState),
    db
      .select({
        entryId: webhookState.entryId,
        number: entry.number,
        title: entry.title,
        attempts: webhookState.attempts,
        lastError: webhookState.lastError,
        nextAttemptAt: webhookState.nextAttemptAt,
      })
      .from(webhookState)
      .innerJoin(entry, eq(entry.id, webhookState.entryId))
      .where(isNotNull(webhookState.lastError))
      .orderBy(desc(webhookState.nextAttemptAt))
      .limit(10),
  ]);
  return {
    delivered: synced?.value ?? 0,
    waiting: waiting?.value ?? 0,
    failingCount: failingCount?.value ?? 0,
    lastDeliveredAt: last?.value ?? null,
    failing,
  };
}
