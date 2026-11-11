import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export const PASSWORD = "logbuch-dev";

/** Signs in through the development Keycloak. */
export async function signIn(page: Page, username: string): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/realms\/logbuch\//);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
}

/** No WCAG 2.1 A/AA violations on the current page. */
export async function expectAccessible(page: Page): Promise<void> {
  // Next.js streams the title after the page; after a client-side navigation
  // axe could otherwise run before it is back. Every title ends in "Logbuch".
  await expect(page).toHaveTitle(/Logbuch$/);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Collects Content Security Policy violations reported by the browser. */
export function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  return violations;
}

/** Picks an option in an OptionPicker or EntryPicker combobox. */
export async function pick(page: Page, label: string, option: string | RegExp, search?: string): Promise<void> {
  // Optional fields are labelled "<label> (optional)".
  await page.getByLabel(new RegExp(`^${label}( \\(optional\\))?$`)).click();
  // A popover that just closed may still be animating out; use the newest.
  if (search) await page.getByPlaceholder(/Search/).last().fill(search);
  await page.getByRole("option", { name: option }).first().click();
  await page.keyboard.press("Escape");
  // Wait for the closing popover to finish its animation; a half-faded list
  // fails axe's colour-contrast check.
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/**
 * Removes `required` from the personal data confirmation, so a submit reaches
 * the server. The checkbox is a button; the browser checks its hidden input.
 */
export async function skipPersonalDataCheck(page: Page): Promise<void> {
  await page.locator('input[name="personalDataConfirmed"]').evaluate((input) => input.removeAttribute("required"));
}

export async function confirmNoPersonalData(page: Page): Promise<void> {
  await page.getByRole("checkbox", { name: "I confirm that this entry contains no personal data." }).check();
}

/** A suffix that keeps titles unique across runs against the same database. */
export const runId = Date.now().toString(36);

/**
 * Moves a proposal's deadlines into the past, so a test does not wait for
 * working days to pass. Needs DATABASE_URL (the database of the app under test).
 */
export async function passDeadlines(ref: string, phases: ("feedback" | "objection")[]): Promise<void> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const number = Number(ref.replace(/^LB-/, ""));
    for (const phase of phases) {
      const column = phase === "feedback" ? "feedback_deadline" : "objection_deadline";
      await client.query(
        `update proposal set ${column} = current_date - 7 where entry_id = (select id from entry where number = $1)`,
        [number],
      );
    }
  } finally {
    await client.end();
  }
}

export interface Delivery {
  event: string;
  channel: string;
  status: string;
  recipient: string;
}

/** The notifications recorded for an entry, with their status. Needs DATABASE_URL. */
export async function deliveries(ref: string): Promise<Delivery[]> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query<Delivery>(
      `select d.event, d.channel, d.status, p.display_name as recipient
         from notification_delivery d
         join person p on p.id = d.recipient_id
         join entry e on e.id = d.entry_id
        where e.number = $1
        order by d.created_at, p.display_name`,
      [Number(ref.replace(/^LB-/, ""))],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

/** The development Keycloak, administered with its bootstrap admin (compose.dev.yaml). */
const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? "http://localhost:8090";

async function keycloakAdmin(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: "admin" }),
  }).then(async (response) => ((await response.json()) as { access_token: string }).access_token);
  const response = await fetch(`${KEYCLOAK_URL}/admin/realms/logbuch${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`Keycloak ${init.method ?? "GET"} ${path}: HTTP ${response.status}`);
  return response;
}

/** Adds a user of the development realm to a group, or removes them from it. */
export async function setGroupMembership(username: string, groupPath: string, member: boolean): Promise<void> {
  const [user] = (await (await keycloakAdmin(`/users?exact=true&username=${encodeURIComponent(username)}`)).json()) as { id: string }[];
  const group = (await (await keycloakAdmin(`/group-by-path/${groupPath.replace(/^\//, "")}`)).json()) as { id: string };
  await keycloakAdmin(`/users/${user!.id}/groups/${group.id}`, { method: member ? "PUT" : "DELETE" });
}
