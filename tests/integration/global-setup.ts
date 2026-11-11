import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

/**
 * Recreates the test database and applies all migrations, once per run.
 * TEST_DATABASE_URL defaults to the PostgreSQL of compose.dev.yaml.
 */
export default async function setup() {
  const url = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://logbuch:logbuch@localhost:55432/logbuch_test",
  );
  const database = url.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(database) || !database.endsWith("_test")) {
    throw new Error(`Refusing to recreate "${database}": the test database name must end with _test`);
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.query(`create database ${database}`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: url.toString() });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle") });
  } finally {
    await pool.end();
  }
}
