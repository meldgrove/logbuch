import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getDatabaseConfig } from "@/lib/config";
import { envValue } from "@/lib/env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function createPool(connectionString: string, applicationName: string): Pool {
  return new Pool({
    connectionString,
    application_name: applicationName,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}

// One pool per process. Kept on globalThis so that hot reload in development
// does not open a new pool on every change.
const globalForDb = globalThis as unknown as { logbuchPool?: Pool; logbuchDb?: Database };

export function getPool(): Pool {
  globalForDb.logbuchPool ??= createPool(
    getDatabaseConfig().DATABASE_URL,
    `logbuch-${envValue("LOGBUCH_PROCESS") ?? "web"}`,
  );
  return globalForDb.logbuchPool;
}

export function getDb(): Database {
  globalForDb.logbuchDb ??= createDb(getPool());
  return globalForDb.logbuchDb;
}
