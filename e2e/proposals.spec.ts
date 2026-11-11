import { expect, test, type Browser, type Page } from "@playwright/test";
import { confirmNoPersonalData, deliveries, expectAccessible, passDeadlines, pick, runId, signIn } from "./helpers";

/** The worker sends notifications within seconds (console transport in tests). */
async function expectSent(ref: string, event: string, recipient: string) {
  await expect
    .poll(async () => (await deliveries(ref)).filter((d) => d.event === event && d.recipient === recipient), { timeout: 20_000 })
    .toEqual([{ event, channel: "slack", status: "sent", recipient }]);
}

/** A separate browser context per person (axe needs pages from a context). */
async function as(browser: Browser, username: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, username);
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  return page;
}

/** The decider publishes from the Decide page. */
async function publish(page: Page, rationale: string) {
  const form = page.getByRole("region", { name: "Publish the decision" });
  await form.getByLabel("Rationale", { exact: true }).fill(rationale);
  await form.getByRole("checkbox", { name: /no personal data/ }).check();
  await form.getByRole("button", { name: "Publish decision" }).click();
}

/** Erika writes and submits a proposal; Adam decides. Returns the LB reference. */
async function propose(page: Page, options: { title: string; oneWay: boolean }) {
  await page.goto("/new/proposal");
  await page.getByLabel("Title").fill(options.title);
  await page.getByLabel("Question", { exact: true }).fill("Should we try it?");
  await page.getByLabel("Context").fill("Focus time is scarce.");
  await page.getByLabel("Proposal", { exact: true }).fill("We try a four-day week for three months.");
  if (options.oneWay) {
    await page.getByRole("radio", { name: /One-way/ }).check();
    await page.getByLabel("Why one-way").fill("Employment contracts change.");
    await pick(page, "Consent givers", "Adam Admin");
  } else {
    await pick(page, "Feedback from", "Adam Admin");
  }
  await pick(page, "Decider", "Adam Admin");
  await page.getByRole("radio", { name: /^Medium\b/ }).check();
  await page.getByRole("button", { name: "Save draft and preview" }).click();
  await page.waitForURL(/\/e\/LB-\d+$/);
  await expect(page.getByRole("heading", { name: "Private draft" })).toBeVisible();
  await expectAccessible(page);
  const ref = page.url().split("/e/")[1]!;

  await confirmNoPersonalData(page);
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.getByRole("heading", { name: "Feedback phase" })).toBeVisible();
  return ref;
}

test("a two-way proposal goes from feedback to an early objection round to a decision", async ({ browser }) => {
  const title = `Four-day week ${runId}`;
  const erika = await as(browser, "erika");
  const ref = await propose(erika, { title, oneWay: false });

  // Adam is asked for feedback, in My tasks and on Slack.
  await expectSent(ref, "proposal.submitted", "Adam Admin");
  const adam = await as(browser, "adam");
  await adam.goto("/tasks");
  await expect(adam.getByRole("link", { name: new RegExp(`Feedback requested.*${title}`) })).toBeVisible();
  await adam.goto(`/e/${ref}`);
  await adam.getByLabel("Type").selectOption("feedback");
  await adam.getByLabel("Text").fill("Good idea, let's try.");
  await adam.getByRole("button", { name: "Post" }).click();
  await expect(adam.getByText("Good idea, let's try.")).toBeVisible();

  // Everyone asked gave feedback, so the objection round may start early.
  await erika.reload();
  await erika.getByRole("button", { name: "Start the objection round" }).click();
  await expect(erika.getByRole("heading", { name: "Objection round" })).toBeVisible();

  await adam.reload();
  await adam.getByRole("button", { name: /Give my Go/ }).click();
  await expect(adam.getByText("Go", { exact: true }).first()).toBeVisible();
  await adam.getByRole("link", { name: "Decide", exact: true }).click();
  await expect(adam.getByText(/everyone asked has answered \(1 of 1\)/)).toBeVisible();
  await expectAccessible(adam);
  // Adam's own Go made it ready, so he gets no message about it.
  await publish(adam, "Focus time matters more than the extra day.");
  await adam.waitForURL(new RegExp(`/e/${ref}$`));
  await expect(adam.getByRole("heading", { name: /^Decided on .* by Adam Admin$/ })).toBeVisible();
  await expectSent(ref, "proposal.closed", "Erika Employee");

  await erika.goto(`/?q=${encodeURIComponent(title)}`);
  await expect(erika.getByRole("article").getByText("Decided by proposal", { exact: true })).toBeVisible();
  await erika.context().close();
  await adam.context().close();
});

test("a one-way proposal stays blocked until the consent giver gives a Go on the current version", async ({ browser }) => {
  const title = `New contracts ${runId}`;
  const erika = await as(browser, "erika");
  const ref = await propose(erika, { title, oneWay: true });

  // One-way: no early start, even with feedback.
  await expect(erika.getByText(/moves to the objection round after the feedback deadline/)).toBeVisible();
  await passDeadlines(ref, ["feedback"]);
  await erika.reload();
  await erika.getByRole("button", { name: "Start the objection round" }).click();
  await expect(erika.getByRole("heading", { name: "Objection round" })).toBeVisible();

  const adam = await as(browser, "adam");
  await adam.goto(`/e/${ref}`);
  await adam.getByRole("button", { name: "Give my Go on version 1" }).click();
  await expect(adam.getByRole("button", { name: "Withdraw my Go" })).toBeVisible();

  // A new version asks the consent giver to confirm again.
  await erika.reload();
  await erika.getByText("Add a new version").click();
  await erika.getByLabel("Change note").fill("Start in January.");
  await confirmNoPersonalData(erika);
  await erika.getByRole("button", { name: "Save new version" }).click();
  await expect(erika.getByRole("heading", { name: "Proposal, version 2" })).toBeVisible();
  await expect(erika.getByText("Go on an older version, asked to confirm again")).toBeVisible();

  await passDeadlines(ref, ["objection"]);
  await adam.goto(`/e/${ref}/decide`);
  await expect(adam.getByText(/Every consent giver gave a Go on version 2 \(0 of 1\)/)).toBeVisible();
  await expect(adam.getByText("Not all criteria are met yet.")).toBeVisible();

  // An objection from the consent giver blocks until it is resolved.
  await adam.goto(`/e/${ref}`);
  await adam.getByLabel("Type").selectOption("objection");
  await adam.getByLabel("Text").fill("Payroll needs a month.");
  await adam.getByRole("button", { name: "Post" }).click();
  await expect(adam.getByText("Blocking")).toBeVisible();
  await adam.getByRole("button", { name: "Mark my objection resolved" }).click();
  await expect(adam.getByText("Resolved", { exact: true })).toBeVisible();
  await adam.getByRole("button", { name: "Give my Go on version 2" }).click();
  await expect(adam.getByRole("button", { name: "Withdraw my Go" })).toBeVisible();

  await adam.goto(`/e/${ref}/decide`);
  await publish(adam, "All consent givers agreed.");
  await adam.waitForURL(new RegExp(`/e/${ref}$`));
  await expect(adam.getByRole("heading", { name: /^Decided on/ })).toBeVisible();
  await erika.context().close();
  await adam.context().close();
});

test("a draft is private to its proposer and can be discarded", async ({ browser }) => {
  const erika = await as(browser, "erika");
  await erika.goto("/new/proposal");
  await erika.getByLabel("Title").fill(`Private draft ${runId}`);
  await erika.getByLabel("Question", { exact: true }).fill("Just thinking?");
  await erika.getByRole("button", { name: "Save draft and preview" }).click();
  await erika.waitForURL(/\/e\/LB-\d+$/);
  const ref = erika.url().split("/e/")[1]!;
  await expect(erika.getByText("Before you can submit:")).toBeVisible();

  const adam = await as(browser, "adam");
  const response = await adam.goto(`/e/${ref}`);
  expect(response?.status()).toBe(404);

  await erika.getByRole("button", { name: "Discard draft" }).click();
  await erika.waitForURL(/\/$/);
  const gone = await erika.goto(`/e/${ref}`);
  expect(gone?.status()).toBe(404);
  await erika.context().close();
  await adam.context().close();
});
