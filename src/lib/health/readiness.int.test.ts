import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { checkReadiness, latestMigrationMillis } from "./readiness";

const testDb = connectTestDatabase();
afterAll(() => testDb.close());

describe("checkReadiness", () => {
  it("is ready when the database answers and every migration is applied", async () => {
    await expect(checkReadiness(testDb.pool)).resolves.toEqual({
      ready: true,
      checks: { database: true, migrations: true },
    });
  });

  it("is not ready when this build has a newer migration than the database", async () => {
    const result = await checkReadiness(testDb.pool, latestMigrationMillis() + 1);
    expect(result).toEqual({ ready: false, checks: { database: true, migrations: false } });
  });

  it("is not ready when the database cannot be reached", async () => {
    const unreachable = new Pool({ connectionString: "postgres://x:y@127.0.0.1:1/none", connectionTimeoutMillis: 1_000 });
    try {
      const result = await checkReadiness(unreachable);
      expect(result.ready).toBe(false);
      expect(result.checks).toEqual({ database: false, migrations: false });
    } finally {
      await unreachable.end();
    }
  });
});
