import { expect, test } from "@playwright/test";
import { collectCspViolations, expectAccessible, setGroupMembership, signIn } from "./helpers";

test("a member of the access group signs in and sees the timeline", async ({ page }) => {
  const cspViolations = collectCspViolations(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expectAccessible(page);

  await signIn(page, "erika");

  await expect(page).toHaveURL(/localhost:3000\/$/);
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(page.getByTestId("current-user")).toHaveText("Erika Employee");
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  await expectAccessible(page);
  expect(cspViolations).toEqual([]);
});

test("pages carry a nonce-based Content Security Policy", async ({ page }) => {
  const response = await page.goto("/login");
  const csp = response?.headers()["content-security-policy"] ?? "";
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("form-action 'self' http://localhost:8090");
  // Next.js puts the nonce on the scripts it renders. Scripts those load
  // later carry none and are allowed by 'strict-dynamic'.
  const scriptNonces = await page
    .locator("script[src]")
    .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).nonce).filter(Boolean));
  expect(scriptNonces.length).toBeGreaterThan(0);
  expect(new Set(scriptNonces)).toEqual(new Set([nonce]));
});

test("someone who is not an admin cannot open the admin pages", async ({ page }) => {
  await signIn(page, "erika");
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  expect((await page.goto("/admin"))?.status()).toBe(404);
  expect((await page.goto("/admin/people"))?.status()).toBe(404);
});

test("a member of the Keycloak admin group sees the admin area", async ({ page }) => {
  await signIn(page, "adam");
  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Admin", level: 1 })).toBeVisible();
  await expect(page.getByText("People with access", { exact: true }).locator("..")).toContainText("2");
  await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: "Adam Admin" })).toBeVisible();
  // The test worker only logs notifications.
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await expect(page.locator("dt", { hasText: /^Slack$/ }).locator("..")).toContainText("Log only (development)");
  // Without WEBHOOK_URL, the worker sends nothing.
  await expect(page.getByRole("heading", { name: "Webhook" })).toBeVisible();
  await expect(page.locator("dt", { hasText: /^Webhook$/ }).locator("..")).toContainText("Off");
  await expectAccessible(page);

  // People and teams come from Keycloak and are read-only.
  await page.getByRole("link", { name: "People", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "People", level: 1 })).toBeVisible();
  const erika = page.getByRole("row").filter({ hasText: "Erika Employee" });
  await expect(erika).toContainText("Engineering");
  await expect(page.getByRole("button", { name: "Invite" })).toHaveCount(0);
  await expectAccessible(page);
  await page.goto("/admin/teams");
  await expect(page.getByRole("row").filter({ hasText: "Operations" })).toContainText("1");
  await expectAccessible(page);
  await page.goto("/admin");

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sync finished|less than 10 seconds ago/ })).toBeVisible();
});

test("everyone sees the statistics, including themselves as active this month", async ({ page }) => {
  await signIn(page, "erika");
  await page.getByRole("link", { name: "Statistics" }).click();
  await expect(page.getByRole("heading", { name: "Statistics", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "By month" })).toBeVisible();
  const measures = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Active people" }) });
  await expect(measures.getByRole("row").nth(1).getByRole("cell").last()).toHaveText(/^[1-9]\d* \(\d+ %\)$/);
  await expectAccessible(page);
});

test("someone outside the access group is denied", async ({ page, context }) => {
  await signIn(page, "olga");
  await expect(page).toHaveURL(/\/no-access$/);
  await expect(page.getByRole("heading", { name: "No access to Logbuch" })).toBeVisible();
  await expectAccessible(page);
  // No Logbuch session was created.
  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.name.includes("session_token"))).toBe(false);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("signing out also ends the identity provider's session", async ({ page }) => {
  await signIn(page, "erika");
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();

  // Sign out sits in the account menu at the bottom of the sidebar.
  await page.getByTestId("current-user").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // Keycloak asks for credentials again instead of signing in silently.
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("Username or email")).toBeVisible();
});

test("someone removed from the access group loses their session at the next sync", async ({ browser }) => {
  const member = await browser.newPage();
  const admin = await browser.newPage();
  try {
    await signIn(member, "erika");
    await expect(member.getByRole("heading", { name: "Timeline" })).toBeVisible();

    await setGroupMembership("erika", "/logbuch", false);
    await signIn(admin, "adam");
    await admin.goto("/admin");
    // A sync may have run in the last 10 seconds; retry until one runs.
    await expect(async () => {
      await admin.getByRole("button", { name: "Sync now" }).click();
      await expect(
        admin.getByRole("status").filter({ hasText: /Sync finished: 1 person listed, 0 gained access, 1 lost access/ }),
      ).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000, intervals: [3_000] });
    await expect(admin.getByText("People with access", { exact: true }).locator("..")).toContainText("1");

    await member.reload();
    await expect(member).toHaveURL(/\/login$/);
  } finally {
    await setGroupMembership("erika", "/logbuch", true);
    // Give the access back, so later tests can sign in as erika right away.
    await expect(async () => {
      await admin.getByRole("button", { name: "Sync now" }).click();
      await expect(admin.getByRole("status").filter({ hasText: /Sync finished: 2 people listed, 1 gained access/ })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000, intervals: [3_000] });
    await member.close();
    await admin.close();
  }
});
