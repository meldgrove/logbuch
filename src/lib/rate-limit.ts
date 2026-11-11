import { sql } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { rateLimit } from "@/lib/db/schema";

export class RateLimitError extends Error {
  constructor() {
    super("Too many changes in a short time. Wait a few minutes and try again.");
    this.name = "RateLimitError";
  }
}

/** Per person: at most 30 writes in 10 minutes. */
export const WRITE_LIMIT = { limit: 30, windowSeconds: 600 };

/**
 * Counts one action against a fixed time window stored in PostgreSQL and
 * throws RateLimitError when the limit is exceeded.
 */
export async function consumeRateLimit(
  db: Database,
  key: string,
  { limit, windowSeconds }: { limit: number; windowSeconds: number },
  now: Date = new Date(),
): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await db
    .insert(rateLimit)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimit.key, rateLimit.windowStart],
      set: { count: sql`${rateLimit.count} + 1` },
    })
    .returning({ count: rateLimit.count });
  if ((row?.count ?? 0) > limit) throw new RateLimitError();
}
