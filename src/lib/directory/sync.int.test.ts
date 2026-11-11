import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { directoryPerson, snapshot, TEAM_OPS, TEAM_TECH } from "../../../tests/fixtures/directory";
import { authAccount, authSession, authUser, directorySyncRun, person, team } from "@/lib/db/schema";
import { syncDirectory } from "./sync";
import type { DirectoryAdapter, DirectorySnapshot } from "./types";

const testDb = connectTestDatabase();
const { db, pool } = testDb;

function adapterReturning(...snapshots: DirectorySnapshot[]): DirectoryAdapter {
  let index = 0;
  return {
    name: "fixture",
    async fetchSnapshot() {
      const next = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      if (!next) throw new Error("no snapshot");
      return structuredClone(next);
    },
  };
}

const failingAdapter: DirectoryAdapter = {
  name: "keycloak",
  async fetchSnapshot() {
    throw new Error("connect ECONNREFUSED");
  },
};

async function sync(adapter: DirectoryAdapter, extra: { minIntervalMs?: number; now?: () => Date } = {}) {
  return syncDirectory({ pool, adapter, trigger: "manual", ...extra });
}

async function people() {
  const rows = await db.select().from(person).orderBy(person.externalId);
  return new Map(rows.map((row) => [row.externalId, row]));
}

/** A Better Auth user with an OIDC account and one session. */
async function loginSession(subject: string, token: string) {
  const userId = `user-${subject}`;
  await db
    .insert(authUser)
    .values({ id: userId, name: subject, email: `${subject}@example.test` })
    .onConflictDoNothing();
  await db
    .insert(authAccount)
    .values({ id: `account-${subject}`, accountId: subject, providerId: "oidc", userId })
    .onConflictDoNothing();
  await db.insert(authSession).values({
    id: `session-${token}`,
    token,
    userId,
    oidcSubject: subject,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

beforeEach(() => testDb.reset());
afterAll(() => testDb.close());

describe("syncDirectory", () => {
  it("grants access to everyone listed and stores teams and the admin flag", async () => {
    const result = await sync(
      adapterReturning(
        snapshot([
          directoryPerson({ externalId: "p1" }),
          directoryPerson({
            externalId: "p2",
            isAdmin: true,
            displayName: "Ada Admin",
            teamExternalId: null,
          }),
        ]),
      ),
    );

    expect(result).toMatchObject({ status: "succeeded", peopleReceived: 2, accessGranted: 2, accessRemoved: 0 });
    const rows = await people();
    expect(rows.get("p1")).toMatchObject({ hasAccess: true, isAdmin: false, oidcSubject: "sub-p1" });
    expect(rows.get("p2")).toMatchObject({ hasAccess: true, isAdmin: true, displayName: "Ada Admin", teamId: null });

    const [techTeam] = await db.select().from(team).where(eq(team.externalId, TEAM_TECH.externalId));
    expect(rows.get("p1")?.teamId).toBe(techTeam?.id);

    const [run] = await db.select().from(directorySyncRun);
    expect(run).toMatchObject({ status: "succeeded", trigger: "manual", peopleReceived: 2, teamsReceived: 2 });
    expect(run?.finishedAt).toBeInstanceOf(Date);
  });

  it("removes access from people who are no longer listed, keeps their row, and ends their sessions", async () => {
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" }), directoryPerson({ externalId: "p2", isAdmin: true })])));
    await loginSession("sub-p1", "token-p1");
    await loginSession("sub-p2", "token-p2a");
    await loginSession("sub-p2", "token-p2b");

    const result = await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" })])));

    expect(result).toMatchObject({ status: "succeeded", accessGranted: 0, accessRemoved: 1, sessionsEnded: 2 });
    const rows = await people();
    expect(rows.get("p2")).toMatchObject({ hasAccess: false, isAdmin: false, displayName: "Person p2" });
    const sessions = await db.select({ token: authSession.token }).from(authSession);
    expect(sessions.map((s) => s.token)).toEqual(["token-p1"]);
  });

  it("gives access back when a person is listed again", async () => {
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" }), directoryPerson({ externalId: "p2" })])));
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" })])));
    const result = await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" }), directoryPerson({ externalId: "p2" })])));
    expect(result).toMatchObject({ status: "succeeded", accessGranted: 1, accessRemoved: 0 });
    expect((await people()).get("p2")?.hasAccess).toBe(true);
  });

  it("updates team, admin flag, and name, and keeps access_changed_at while access is unchanged", async () => {
    let time = new Date("2026-11-04T09:00:00Z");
    const now = () => time;
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1", isAdmin: true })])), { now });
    const before = (await people()).get("p1");

    time = new Date("2026-11-04T09:15:00Z");
    await sync(
      adapterReturning(
        snapshot([
          directoryPerson({
            externalId: "p1",
            displayName: "Renamed",
            isAdmin: false,
            teamExternalId: TEAM_OPS.externalId,
          }),
        ]),
      ),
      { now },
    );

    const after = (await people()).get("p1");
    const [opsTeam] = await db.select().from(team).where(eq(team.externalId, TEAM_OPS.externalId));
    expect(after).toMatchObject({ displayName: "Renamed", isAdmin: false, teamId: opsTeam?.id });
    expect(after?.accessChangedAt).toEqual(before?.accessChangedAt);
    expect(after?.lastSeenInDirectoryAt).toEqual(new Date("2026-11-04T09:15:00Z"));
  });

  it("forgets the cached Slack user when the work email changes, and keeps it otherwise", async () => {
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1", email: "a@example.test" }), directoryPerson({ externalId: "p2", email: "b@example.test" })])));
    await db.update(person).set({ slackUserId: "U1", slackLookupFailedAt: new Date() });
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1", email: "new@example.test" }), directoryPerson({ externalId: "p2", email: "b@example.test" })])));
    const after = await people();
    expect(after.get("p1")).toMatchObject({ slackUserId: null, slackLookupFailedAt: null });
    expect(after.get("p2")?.slackUserId).toBe("U1");
  });

  it("takes access from people added by hand before the directory was used", async () => {
    const [manual] = await db
      .insert(person)
      .values({ displayName: "Manual Person", workEmail: "manual@example.test", oidcSubject: "sub-manual", hasAccess: true })
      .returning();
    await loginSession("sub-manual", "token-manual");
    const result = await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" })])));
    expect(result).toMatchObject({ status: "succeeded", accessRemoved: 1, sessionsEnded: 1 });
    const [after] = await db.select().from(person).where(eq(person.id, manual!.id));
    expect(after).toMatchObject({ hasAccess: false, displayName: "Manual Person" });
  });

  it("marks teams that disappeared from the directory as inactive", async () => {
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" })], [TEAM_TECH, TEAM_OPS])));
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" })], [TEAM_TECH])));
    const rows = await db.select().from(team).orderBy(team.externalId);
    expect(rows.map((t) => [t.name, t.isActive])).toEqual([
      ["Engineering", true],
      ["Operations", false],
    ]);
  });

  it("deactivates teams made by hand before the directory was used, and keeps them on their people", async () => {
    const [handMade] = await db.insert(team).values({ name: "Hand-made" }).returning();
    const [manual] = await db.insert(person).values({ displayName: "Manual Person", teamId: handMade!.id, hasAccess: true }).returning();
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" })], [TEAM_TECH])));
    const rows = await db.select().from(team).orderBy(team.name);
    expect(rows.map((t) => [t.name, t.externalId === null, t.isActive])).toEqual([
      ["Engineering", false, true],
      ["Hand-made", true, false],
    ]);
    const [after] = await db.select().from(person).where(eq(person.id, manual!.id));
    expect(after?.teamId).toBe(handMade!.id);
  });

  it("keeps people and teams when the directory returns no teams", async () => {
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" })])));
    const result = await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" }), directoryPerson({ externalId: "p2" })], [])));
    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/no teams/) });
    expect([...(await people()).keys()]).toEqual(["p1"]);
    expect((await db.select().from(team)).every((t) => t.isActive)).toBe(true);
  });

  it("keeps the last projection when the directory cannot be reached", async () => {
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" })])));
    const result = await sync(failingAdapter);

    expect(result).toMatchObject({ status: "failed", error: "connect ECONNREFUSED" });
    expect((await people()).get("p1")?.hasAccess).toBe(true);
    const runs = await db.select().from(directorySyncRun).orderBy(directorySyncRun.startedAt);
    expect(runs.map((r) => r.status)).toEqual(["succeeded", "failed"]);
    expect(runs[1]?.error).toBe("connect ECONNREFUSED");
  });

  it("keeps the last projection when the directory returns no people", async () => {
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" })])));
    const result = await sync(adapterReturning(snapshot([])));
    expect(result.status).toBe("failed");
    expect((await people()).get("p1")?.hasAccess).toBe(true);
  });

  it("moves a Keycloak user to a new identity without breaking uniqueness", async () => {
    await sync(adapterReturning(snapshot([directoryPerson({ externalId: "old", subject: "sub-same" })])));
    const result = await sync(adapterReturning(snapshot([directoryPerson({ externalId: "new", subject: "sub-same" })])));

    expect(result.status).toBe("succeeded");
    const rows = await people();
    expect(rows.get("old")).toMatchObject({ hasAccess: false, oidcSubject: null });
    expect(rows.get("new")).toMatchObject({ hasAccess: true, oidcSubject: "sub-same" });
  });

  it("handles Keycloak users that move between people who both stay listed", async () => {
    await sync(
      adapterReturning(
        snapshot([
          directoryPerson({ externalId: "a", subject: "sub-1" }),
          directoryPerson({ externalId: "b", subject: "sub-2" }),
        ]),
      ),
    );
    const result = await sync(
      adapterReturning(
        snapshot([
          directoryPerson({ externalId: "a", subject: "sub-2" }),
          directoryPerson({ externalId: "b", subject: "sub-1" }),
        ]),
      ),
    );

    expect(result.status).toBe("succeeded");
    const rows = await people();
    expect(rows.get("a")).toMatchObject({ hasAccess: true, oidcSubject: "sub-2" });
    expect(rows.get("b")).toMatchObject({ hasAccess: true, oidcSubject: "sub-1" });
  });

  it("skips a run when the previous one started too recently", async () => {
    const adapter = adapterReturning(snapshot([directoryPerson({ externalId: "p1" })]));
    await sync(adapter);
    await expect(sync(adapter, { minIntervalMs: 60_000 })).resolves.toEqual({
      status: "skipped",
      reason: "ran_recently",
    });
    await expect(sync(adapter, { minIntervalMs: 60_000, now: () => new Date(Date.now() + 61_000) })).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("runs only one sync at a time", async () => {
    const other = await pool.connect();
    try {
      await other.query("select pg_advisory_lock(7261001)");
      await expect(sync(adapterReturning(snapshot([directoryPerson({ externalId: "p1" })])))).resolves.toEqual({
        status: "skipped",
        reason: "already_running",
      });
    } finally {
      await other.query("select pg_advisory_unlock(7261001)");
      other.release();
    }
  });
});
