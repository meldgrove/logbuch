import { expect, test, type Page } from "@playwright/test";
import { collectCspViolations, confirmNoPersonalData, expectAccessible, pick, runId, signIn, skipPersonalDataCheck } from "./helpers";

/** Chooses one of the radio cards, e.g. the impact "Small". */
async function choose(page: Page, name: string) {
  await page.getByRole("radio", { name: new RegExp(`^${name}\\b`) }).check();
}

async function postUpdate(page: Page, title: string) {
  await page.goto("/new/log?type=update");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Summary").fill(`Summary of ${title}.`);
  await page.getByLabel("Details").fill("The checklist lives in **the wiki**.");
  await page.getByLabel("Links").fill("https://example.org/checklist");
  await choose(page, "Small");
  await confirmNoPersonalData(page);
  await page.getByRole("button", { name: "Publish update" }).click();
  await page.waitForURL(/\/e\/LB-\d+$/);
  return page.url().split("/e/")[1]!;
}

test("an employee posts an update with Markdown and a link, and finds it in the timeline", async ({ page }) => {
  const cspViolations = collectCspViolations(page);
  const title = `Onboarding checklist ${runId}`;
  await signIn(page, "erika");
  await page.goto("/new");
  await page.getByRole("link", { name: /Log something/ }).click();
  await expect(page.getByRole("heading", { name: "Log something" })).toBeVisible();
  await choose(page, "Update");
  // The team comes from the author and can be changed.
  await expect(page.getByText("Team: Engineering")).toBeVisible();
  await expect(page.getByText(/Do not enter personal data/)).toBeVisible();
  await expectAccessible(page);

  const ref = await postUpdate(page, title);

  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator("strong", { hasText: "the wiki" })).toBeVisible();
  await expect(page.getByRole("link", { name: "https://example.org/checklist" })).toBeVisible();
  await expectAccessible(page);

  await page.goto("/");
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  // The search in the sidebar finds entries while typing; Enter opens the first.
  await page.keyboard.press("ControlOrMeta+K");
  const search = page.getByRole("dialog", { name: "Search entries" });
  await search.getByRole("combobox").fill(`${runId} onboard`);
  await expect(search.getByRole("option")).toHaveCount(1);
  await expect(search.getByRole("option", { name: new RegExp(`${ref}.*${title}`) })).toBeVisible();
  await expectAccessible(page);
  await search.getByRole("combobox").press("Enter");
  await expect(page).toHaveURL(new RegExp(`/e/${ref}$`));
  await expect(search).toBeHidden();

  // "View all results" shows the search in the timeline.
  await page.getByRole("button", { name: "Search entries" }).click();
  await search.getByRole("combobox").fill(ref);
  await expect(search.getByRole("option", { name: new RegExp(`${ref}.*${title}`) })).toBeVisible();
  await search.getByRole("button", { name: "View all results" }).click();
  await expect(page).toHaveURL(new RegExp(`/\\?q=${ref}$`));
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  // Filters keep the search; each active filter is a chip that removes it.
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Type").selectOption({ label: "Update" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?q=${ref}&type=update$`));
  await expect(page.getByRole("article")).toHaveCount(1);
  await expectAccessible(page);
  await page.getByRole("link", { name: "Remove filter Type: Update" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?q=${ref}$`));
  await page.getByRole("link", { name: `Remove filter Search: “${ref}”` }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(cspViolations).toEqual([]);
});

test("the server refuses an entry without the personal data confirmation", async ({ page }) => {
  const title = `Unconfirmed ${runId}`;
  await signIn(page, "erika");
  await page.goto("/new/log?type=update");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Summary").fill("Should not be published.");
  await choose(page, "Small");
  // Bypass the browser's required check to reach the server.
  await skipPersonalDataCheck(page);
  await page.getByRole("button", { name: "Publish update" }).click();

  await expect(page.getByText("Confirm that the entry contains no personal data.")).toBeVisible();
  await expect(page).toHaveURL(/\/new\/log\?type=update$/);
  await page.goto(`/?q=${encodeURIComponent(title)}`);
  await expect(page.getByText("No entries match these filters.")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/new\/log\?type=update$/);
});

test("after a rejected submit, the form keeps every field, and the retry publishes", async ({ page }) => {
  const title = `Retried ${runId}`;
  await signIn(page, "erika");
  await page.goto("/new/log?type=update");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Summary").fill("Published on the second try.");
  await page.getByLabel("Links").fill("https://example.org/retry");
  await choose(page, "Medium");
  await skipPersonalDataCheck(page);
  await page.getByRole("button", { name: "Publish update" }).click();
  await expect(page.getByText("Confirm that the entry contains no personal data.")).toBeVisible();

  await expect(page.getByLabel("Title")).toHaveValue(title);
  await expect(page.getByLabel("Links")).toHaveValue("https://example.org/retry");
  await expect(page.getByRole("radio", { name: /^Medium\b/ })).toBeChecked();
  await confirmNoPersonalData(page);
  await page.getByRole("button", { name: "Publish update" }).click();
  await page.waitForURL(/\/e\/LB-\d+$/);
  await expect(page.getByRole("link", { name: "https://example.org/retry" })).toBeVisible();

  // Decisions keep the select and the one-way choice too.
  await page.goto("/new/log?type=decision");
  await page.getByLabel("How it was decided").selectOption({ label: "Role decision" });
  await page.getByRole("radio", { name: /^One-way/ }).check();
  await skipPersonalDataCheck(page);
  await page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Publish decision" }) })
    .evaluate((form) => form.setAttribute("novalidate", ""));
  await page.getByRole("button", { name: "Publish decision" }).click();
  await expect(page.getByText("Title is required.")).toBeVisible();
  await expect(page.getByText("Explain why the decision is hard to reverse.")).toBeVisible();
  await expect(page.getByLabel("How it was decided")).toHaveValue("role_decision");
  await expect(page.getByRole("radio", { name: /^One-way/ })).toBeChecked();
});

test("the author edits an update; the history shows both versions", async ({ page, browser }) => {
  const title = `Edited update ${runId}`;
  await signIn(page, "erika");
  const ref = await postUpdate(page, title);

  await page.getByRole("link", { name: "Edit" }).click();
  await page.getByLabel("Summary").fill("A corrected summary.");
  await confirmNoPersonalData(page);
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(new RegExp(`/e/${ref}$`));
  await expect(page.getByText("A corrected summary.")).toBeVisible();
  await expect(page.getByText(/· edited /)).toBeVisible();

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText(/^Version 2 ·/)).toBeVisible();
  await expect(page.locator("ins", { hasText: "corrected" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Edited (version 2)" })).toBeVisible();
  await expectAccessible(page);

  // Someone else cannot edit it.
  const other = await browser.newPage();
  await signIn(other, "adam");
  await other.goto(`/e/${ref}`);
  await expect(other.getByRole("link", { name: "Edit" })).toHaveCount(0);
  const response = await other.goto(`/e/${ref}/edit`);
  expect(response?.status()).toBe(404);
  await other.close();
});

test("a logged decision replaces an older one; the decider adds an addendum", async ({ page, browser }) => {
  const oldTitle = `Laptop budget ${runId}`;
  const newTitle = `Laptop budget 2027 ${runId}`;
  await signIn(page, "erika");

  async function postRecord(title: string, supersedes?: string) {
    await page.goto("/new/log?type=decision");
    await expect(page.getByRole("radio", { name: /^Decision\b/ })).toBeChecked();
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Summary").fill("Each new laptop may cost up to 1,600 EUR.");
    await page.getByLabel("Decision text").fill("The laptop budget is 1,600 EUR per person.");
    await page.getByLabel("Rationale").fill("Prices rose; the old limit no longer covers the standard model.");
    await pick(page, "Decider", "Adam Admin");
    await page.getByLabel("How it was decided").selectOption({ label: "Role decision" });
    await choose(page, "Medium");
    if (supersedes) await pick(page, "Supersedes", new RegExp(supersedes), supersedes);
    await confirmNoPersonalData(page);
    await expectAccessible(page);
    await page.getByRole("button", { name: "Publish decision" }).click();
    await page.waitForURL(/\/e\/LB-\d+$/);
    return page.url().split("/e/")[1]!;
  }

  const oldRef = await postRecord(oldTitle);
  await postRecord(newTitle, oldTitle);
  await expect(page.getByText(`Replaces ${oldRef}: ${oldTitle}`)).toBeVisible();
  await expect(page.getByText("Role decision")).toBeVisible();
  // The author is not the decider and not an admin, but may add an addendum as the author.
  await expect(page.getByLabel("Add an addendum")).toBeVisible();

  await page.goto(`/e/${oldRef}`);
  await expect(page.getByText("This decision was replaced")).toBeVisible();

  const decider = await browser.newPage();
  await signIn(decider, "adam");
  await decider.goto(`/e/${oldRef}`);
  await decider.getByLabel("Add an addendum").fill(`Also applies to monitors ${runId}.`);
  await confirmNoPersonalData(decider);
  await decider.getByRole("button", { name: "Add addendum" }).click();
  await expect(decider.getByText(`Also applies to monitors ${runId}.`)).toBeVisible();
  // The form starts empty again, so a second click cannot repeat the addendum.
  await expect(decider.getByLabel("Add an addendum")).toHaveValue("");
  await expect(decider.getByRole("checkbox", { name: /no personal data/ })).not.toBeChecked();
  await decider.close();

  // Search covers addenda, and German word forms match English text.
  await page.goto(`/?type=decision&q=${encodeURIComponent(`Monitore ${runId}`)}`);
  await expect(page.getByRole("link", { name: oldTitle })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);
});

test("admins manage tags; others cannot", async ({ page, browser }) => {
  await signIn(page, "adam");
  await page.goto("/admin");
  await page.getByRole("main").getByRole("link", { name: "Tags", exact: true }).click();
  const name = `Tag ${runId}`;
  await page.getByLabel("Name of the new tag").fill(name);
  await page.getByRole("button", { name: "Add tag" }).click();
  await expect(page.getByLabel(`Rename ${name}`)).toHaveValue(name);
  await expect(page.getByLabel("Name of the new tag")).toHaveValue("");
  await expectAccessible(page);
  const row = page.getByRole("row").filter({ has: page.getByLabel(`Rename ${name}`) });
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(row.getByText("Inactive")).toBeVisible();
  await row.getByRole("button", { name: "Activate" }).click();
  await expect(row.getByText("Active", { exact: true })).toBeVisible();

  const employee = await browser.newPage();
  await signIn(employee, "erika");
  const response = await employee.goto("/admin/tags");
  expect(response?.status()).toBe(404);
  await employee.goto("/new/log");
  await pick(employee, "Tags", name);
  await expect(employee.getByRole("list", { name: "Selected" }).getByText(name)).toBeVisible();
  await employee.close();
});

test("a Large learning is marked must read; its author lowers the impact later", async ({ page }) => {
  const title = `Launch retro ${runId}`;
  await signIn(page, "erika");
  await page.goto("/new/log");
  await choose(page, "Learning");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Summary").fill("Ship smaller releases.");
  await page.getByLabel("Rationale").fill("Two big releases failed this quarter.");
  await choose(page, "Large");
  await pick(page, "Affected teams", "Operations");
  await confirmNoPersonalData(page);
  await page.getByRole("button", { name: "Publish learning" }).click();
  await page.waitForURL(/\/e\/LB-\d+$/);
  await expect(page.getByText("Must read")).toBeVisible();
  await expect(page.getByText("Two big releases failed this quarter.")).toBeVisible();
  await expectAccessible(page);

  await page.goto(`/?impact=large&q=${encodeURIComponent(title)}`);
  await expect(page.getByRole("article").getByText("Must read")).toBeVisible();
  await expect(page.getByRole("article").getByText(/affects Operations/)).toBeVisible();

  // Exact: the chip "Remove filter Search: …" contains the title too.
  await page.getByRole("link", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "Change impact" }).click();
  await page.getByLabel("Impact", { exact: true }).selectOption({ label: "Small" });
  await page.getByRole("button", { name: "Save impact" }).click();
  await expect(page.getByText("Must read")).toHaveCount(0);
  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByRole("cell", { name: "Impact changed (Large → Small)" })).toBeVisible();
});
