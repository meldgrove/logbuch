import { sql } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { personActiveMonth } from "@/lib/db/schema";
import { serverDate } from "@/lib/format";
import { errorMessage, logger } from "@/lib/logger";

/** The first day of the current month in the server's time zone, e.g. "2026-11-01". */
export function serverMonth(now: Date = new Date()): string {
  return `${serverDate(now).slice(0, 7)}-01`;
}

/** `app_setting` key: when activity recording started (set by the first migration). */
export const ACTIVITY_SINCE_KEY = "activity_tracking_since";

/** Person and month pairs this process has already written. */
const recorded = new Set<string>();

/**
 * Notes that a person opened Logbuch this month. Writes at
 * most once per person and month in each process. The database gives up
 * after a short wait, so a lock never holds up a page; a failed write is
 * logged and never fails the request.
 */
export async function recordActivity(db: Database, personId: string, now: Date = new Date()): Promise<void> {
  const month = serverMonth(now);
  const key = `${personId}:${month}`;
  if (recorded.has(key)) return;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '200ms'`);
      await tx.execute(sql`set local statement_timeout = '1s'`);
      await tx.insert(personActiveMonth).values({ personId, month }).onConflictDoNothing();
    });
    recorded.add(key);
  } catch (error) {
    logger.warn({ error: errorMessage(error) }, "could not record activity");
  }
}
