import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "../helpers";

/*
 * The manual directory, against a fresh database: the first admin comes from
 * INITIAL_ADMIN_EMAILS, everyone else needs an invitation. The steps build on
 * each other, so they run in order.
 */
test.describe.configure({ mode: "serial" });

test("the first admin comes from INITIAL_ADMIN_EMAILS", async ({ page }) => {
  await signIn(page, "adam");
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await page.getByRole("link", { name: "People", exact: true }).click();
  await expect(page.getByRole("heading", { name: "People", level: 1 })).toBeVisible();
  const adam = page.getByRole("row").filter({ hasText: "adam@example.test" });
  await expect(adam).toContainText("Active");
  await expect(adam).toContainText("Admin");
  await expectAccessible(page);

  // Every entry needs a team: until there is one, the admin is sent to create it.
  await page.goto("/new");
  await expect(page.getByText("No teams yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin → Teams" })).toHaveAttribute("href", "/admin/teams");
  await expectAccessible(page);
});

test("someone who was not invited is denied", async ({ page }) => {
  await signIn(page, "erika");
  await expect(page).toHaveURL(/\/no-access$/);
  await expect(page.getByRole("heading", { name: "No access to Logbuch" })).toBeVisible();
});

test("an admin creates a team and invites a person, who then signs in", async ({ page, browser }) => {
  await signIn(page, "adam");
  await page.goto("/admin/teams");
  await page.getByLabel("Name of the new team").fill("Engineering");
  await page.getByRole("button", { name: "Add team" }).click();
  await expect(page.getByLabel("Rename Engineering")).toHaveValue("Engineering");
  await expectAccessible(page);

  await page.goto("/admin/people");
  const form = page.getByRole("region", { name: "Invite a person" });
  await form.getByLabel("Email").fill("Erika@Example.test");
  await form.getByLabel("Name").fill("Erika Invited");
  await form.getByLabel("Team (optional)").selectOption({ label: "Engineering" });
  await form.getByRole("button", { name: "Invite" }).click();
  const invited = page.getByRole("row").filter({ hasText: "erika@example.test" });
  await expect(invited).toContainText("Invited");
  await expectAccessible(page);

  const erika = await browser.newPage();
  try {
    await signIn(erika, "erika");
    await expect(erika.getByRole("heading", { name: "Timeline" })).toBeVisible();
    // The name from the identity provider replaces the invitation's.
    await expect(erika.getByTestId("current-user")).toHaveText("Erika Employee");
    await page.reload();
    await expect(page.getByRole("row").filter({ hasText: "erika@example.test" })).toContainText("Active");

    // Taking access away ends her session.
    await page.getByRole("row").filter({ hasText: "erika@example.test" }).getByRole("button", { name: "Remove access" }).click();
    await expect(page.getByRole("row").filter({ hasText: "erika@example.test" })).toContainText("No access");
    await erika.reload();
    await expect(erika).toHaveURL(/\/login$/);
  } finally {
    await erika.close();
  }
});

test("everyone chooses their own date format and time zone", async ({ page }) => {
  await signIn(page, "adam");
  await page.getByTestId("current-user").click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  // The default is DD.MM.YYYY.
  await expect(page.getByText(/^Now: \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/)).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel("Date format").selectOption("YYYY-MM-DD");
  await page.getByLabel("Time zone").selectOption("Asia/Tokyo");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/^Now: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)).toBeVisible();
  await expect(page.getByLabel("Time zone")).toHaveValue("Asia/Tokyo");
});
