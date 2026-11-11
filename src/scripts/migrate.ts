import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { getDatabaseConfig } from "@/lib/config";
import { createDb, createPool } from "@/lib/db/client";
import { envValue } from "@/lib/env";
import { errorMessage, logger } from "@/lib/logger";

// Applies the SQL migrations in drizzle/. Runs as the `migrate` service
// before `web` and `worker` start.
async function waitForDatabase(pool: Pool, attempts = 30): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      logger.info({ attempt, error: errorMessage(error) }, "waiting for the database");
      await sleep(2_000);
    }
  }
}

async function main() {
  const pool = createPool(getDatabaseConfig().DATABASE_URL, "logbuch-migrate");
  try {
    await waitForDatabase(pool);
    const migrationsFolder = envValue("MIGRATIONS_DIR") ?? path.resolve(process.cwd(), "drizzle");
    await migrate(createDb(pool), { migrationsFolder });
    logger.info({ migrationsFolder }, "migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "migration failed");
  process.exit(1);
});
