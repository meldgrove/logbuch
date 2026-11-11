import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against running Logbuch production builds, the development
 * Keycloak, and PostgreSQL. Two instances run side by side:
 *
 * - `keycloak`: DIRECTORY=keycloak on port 3000 (E2E_BASE_URL).
 * - `manual`: DIRECTORY=manual on port 3001 (E2E_MANUAL_BASE_URL), with its
 *   own, fresh database and INITIAL_ADMIN_EMAILS=adam@example.test.
 *
 * AGENTS.md describes the local setup; CI starts the same in the `e2e` job.
 */
export default defineConfig({
  testDir: "e2e",
  // The tests of each project share one database.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "keycloak",
      testIgnore: "manual/**",
      use: { ...devices["Desktop Chrome"], baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" },
    },
    {
      name: "manual",
      testMatch: "manual/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: process.env.E2E_MANUAL_BASE_URL ?? "http://localhost:3001" },
    },
  ],
});
