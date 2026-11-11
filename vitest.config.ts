import path from "node:path";
import { defineConfig } from "vitest/config";

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://logbuch:logbuch@localhost:55432/logbuch_test";

// Deadlines and statistics follow the server's time zone. Tests run in one
// with daylight saving time, so that they cover the switch.
const TZ = "Europe/Amsterdam";
process.env.TZ = TZ;

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts"],
          env: { NODE_ENV: "test", TZ },
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          // One shared database: run test files one after another.
          fileParallelism: false,
          hookTimeout: 60_000,
          testTimeout: 30_000,
          env: { NODE_ENV: "test", TZ, DATABASE_URL: testDatabaseUrl, TEST_DATABASE_URL: testDatabaseUrl },
        },
      },
    ],
  },
});
