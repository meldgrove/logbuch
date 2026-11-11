import type { Pool } from "pg";
import journal from "../../../drizzle/meta/_journal.json";

export interface Readiness {
  ready: boolean;
  checks: { database: boolean; migrations: boolean };
  error?: string;
}

const TIMEOUT_MS = 3_000;

/** The `when` of the newest migration this build ships. */
export function latestMigrationMillis(): number {
  return Math.max(0, ...journal.entries.map((entry) => entry.when));
}

/**
 * The database answers, and the newest applied migration is at least the
 * newest one in this build (drizzle stores the journal's `when` as
 * `created_at` in `drizzle.__drizzle_migrations`).
 */
export async function checkReadiness(pool: Pool, expectedMillis = latestMigrationMillis()): Promise<Readiness> {
  const checks = { database: false, migrations: false };
  try {
    await withTimeout(pool.query("select 1"), TIMEOUT_MS);
    checks.database = true;
    const result = await withTimeout(
      pool.query<{ applied: string | null }>(
        "select max(created_at)::text as applied from drizzle.__drizzle_migrations",
      ),
      TIMEOUT_MS,
    );
    const applied = Number(result.rows[0]?.applied ?? 0);
    checks.migrations = applied >= expectedMillis;
    return { ready: checks.database && checks.migrations, checks };
  } catch (error) {
    return { ready: false, checks, error: error instanceof Error ? error.message : String(error) };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
