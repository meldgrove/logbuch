import { describe, expect, it } from "vitest";
import type { WebhookConfig } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import { WEBHOOK_RECONCILE_CRON, WEBHOOK_SYNC_CRON } from "@/lib/jobs/queues";
import { setUpWebhookJobs } from "./webhook-jobs";

function fakeBoss(existingQueues: string[] = []) {
  const calls: string[] = [];
  const boss = {
    createQueue: async (name: string) => void calls.push(`createQueue ${name}`),
    schedule: async (name: string, cron: string) => void calls.push(`schedule ${name} ${cron}`),
    unschedule: async (name: string) => void calls.push(`unschedule ${name}`),
    work: async (name: string) => {
      calls.push(`work ${name}`);
      return "worker-id";
    },
    send: async (name: string) => {
      calls.push(`send ${name}`);
      return "job-id";
    },
    getQueue: async (name: string) => (existingQueues.includes(name) ? { name } : null),
    deleteQueuedJobs: async (name: string) => {
      calls.push(`deleteQueuedJobs ${name}`);
      return 0;
    },
  };
  return { boss: boss as unknown as Parameters<typeof setUpWebhookJobs>[0], calls };
}

const config = (overrides: Partial<WebhookConfig> = {}): WebhookConfig => ({
  WEBHOOK_URL: undefined,
  WEBHOOK_SECRET: undefined,
  ...overrides,
});
const options = { baseUrl: "https://logbuch.example", db: () => ({}) as Database };

describe("webhook jobs in the worker", () => {
  it("schedule the minute sync and the nightly run, and reconcile once at startup", async () => {
    const { boss, calls } = fakeBoss();
    const mode = await setUpWebhookJobs(boss, {
      ...options,
      config: config({ WEBHOOK_URL: "https://hooks.example.org/logbuch", WEBHOOK_SECRET: "s".repeat(32) }),
    });
    expect(mode).toBe("live");
    expect(calls).toEqual([
      "createQueue webhook-sync",
      `schedule webhook-sync ${WEBHOOK_SYNC_CRON}`,
      "work webhook-sync",
      "createQueue webhook-reconcile",
      `schedule webhook-reconcile ${WEBHOOK_RECONCILE_CRON}`,
      "work webhook-reconcile",
      "send webhook-reconcile",
    ]);
  });

  it("remove the schedules and queued jobs when the webhook is turned off", async () => {
    const { boss, calls } = fakeBoss(["webhook-sync", "webhook-reconcile"]);
    expect(await setUpWebhookJobs(boss, { ...options, config: config() })).toBe("off");
    expect(calls).toEqual([
      "unschedule webhook-sync",
      "deleteQueuedJobs webhook-sync",
      "unschedule webhook-reconcile",
      "deleteQueuedJobs webhook-reconcile",
    ]);
  });

  it("only unschedule when the queues never existed", async () => {
    const { boss, calls } = fakeBoss();
    await setUpWebhookJobs(boss, { ...options, config: config() });
    expect(calls).toEqual(["unschedule webhook-sync", "unschedule webhook-reconcile"]);
  });
});
