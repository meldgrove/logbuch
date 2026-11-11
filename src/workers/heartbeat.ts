import { writeFile } from "node:fs/promises";
import type { Database } from "@/lib/db/client";
import { workerHeartbeat } from "@/lib/db/schema";
import type { NotificationChannels } from "@/lib/notifications/types";
import { errorMessage, logger } from "@/lib/logger";

import { HEARTBEAT_INTERVAL_MS } from "./heartbeat-file";

export { DEFAULT_HEARTBEAT_FILE, HEARTBEAT_INTERVAL_MS } from "./heartbeat-file";

/**
 * Writes a heartbeat every 30 seconds: to a file, which the container health
 * check reads, and to the database, which the admin page shows.
 */
export function startHeartbeat(options: { db: Database; workerId: string; file: string; channels: NotificationChannels }): () => void {
  const startedAt = new Date();

  async function beat() {
    const now = new Date();
    try {
      await writeFile(options.file, now.toISOString());
    } catch (error) {
      logger.warn({ error: errorMessage(error) }, "could not write the heartbeat file");
    }
    try {
      await options.db
        .insert(workerHeartbeat)
        .values({ workerId: options.workerId, startedAt, beatAt: now, channels: options.channels })
        .onConflictDoUpdate({ target: workerHeartbeat.workerId, set: { startedAt, beatAt: now, channels: options.channels } });
    } catch (error) {
      logger.warn({ error: errorMessage(error) }, "could not write the heartbeat to the database");
    }
  }

  void beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}
