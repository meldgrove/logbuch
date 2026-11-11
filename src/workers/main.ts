import { hostname } from "node:os";
import * as Sentry from "@sentry/node";
import { PgBoss } from "pg-boss";
import {
  getDatabaseConfig,
  getErrorReportingConfig,
  getNotificationConfig,
  getWebhookConfig,
  validateWorkerConfig,
} from "@/lib/config";
import { getDb, getPool } from "@/lib/db/client";
import { envValue } from "@/lib/env";
import { asError, sentryOptions } from "@/lib/error-reporting";
import { getDirectory } from "@/lib/directory/directory";
import type { SyncTrigger } from "@/lib/directory/sync";
import { SERVER_TIME_ZONE } from "@/lib/format";
import {
  DIRECTORY_SYNC_CRON,
  DISPATCH_INTERVAL_MS,
  PROPOSAL_WATCH_CRON,
  QUEUES,
  REMINDERS_CRON,
} from "@/lib/jobs/queues";
import { logger } from "@/lib/logger";
import { retrySlackLookups, startDispatcher } from "@/lib/notifications/dispatch";
import { notifyLostAccess, recordReminders } from "@/lib/notifications/notify";
import { refreshReadiness } from "@/lib/process/commands";
import { channelModes, createTransports } from "@/lib/notifications/transports";
import { DEFAULT_HEARTBEAT_FILE, startHeartbeat } from "./heartbeat";
import { setUpWebhookJobs } from "./webhook-jobs";

interface DirectorySyncJob {
  trigger?: SyncTrigger;
}

async function main() {
  validateWorkerConfig();
  const sentry = sentryOptions(getErrorReportingConfig(), "worker");
  // The bundle has no node_modules to hook into at load time.
  if (sentry) Sentry.init({ ...sentry, enableRuntimeChannelInjection: false });
  const boss = new PgBoss({
    connectionString: getDatabaseConfig().DATABASE_URL,
    application_name: "logbuch-worker-pgboss",
  });
  boss.on("error", (error) => {
    logger.error({ err: error }, "pg-boss error");
    Sentry.captureException(asError(error));
  });
  await boss.start();

  // The Keycloak directory syncs every 15 minutes and once at startup, so a
  // fresh deployment has people right away. pg-boss keeps schedules in the
  // database, so the manual directory removes the schedule.
  const directory = getDirectory();
  const sync = directory.sync;
  if (sync) {
    await boss.createQueue(QUEUES.directorySync, { retryLimit: 2, retryDelay: 60, expireInSeconds: 300 });
    await boss.schedule(QUEUES.directorySync, DIRECTORY_SYNC_CRON, { trigger: "schedule" }, { tz: SERVER_TIME_ZONE });
    await boss.work<DirectorySyncJob>(QUEUES.directorySync, async (jobs) => {
      for (const job of jobs) {
        const result = await sync.run(job.data?.trigger ?? "schedule");
        // A failed run is already recorded; failing the job lets pg-boss retry.
        if (result.status === "failed") throw new Error(result.error);
      }
    });
    await boss.send(QUEUES.directorySync, { trigger: "startup" });
  } else {
    await boss.unschedule(QUEUES.directorySync);
    if (await boss.getQueue(QUEUES.directorySync)) await boss.deleteQueuedJobs(QUEUES.directorySync);
  }

  // Notifications: readiness, lost access, and due Slack lookups every few
  // minutes, reminders at 09:00 on working days. Delivery keys make repeated
  // runs harmless, so the reminder job also runs once at startup.
  const notificationConfig = getNotificationConfig();
  const transports = createTransports(notificationConfig);
  const channels = channelModes(transports);
  await boss.createQueue(QUEUES.proposalWatch, { retryLimit: 1, retryDelay: 60, expireInSeconds: 240 });
  await boss.schedule(QUEUES.proposalWatch, PROPOSAL_WATCH_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.proposalWatch, async () => {
    await refreshReadiness(getDb(), new Date());
    await notifyLostAccess(getDb(), new Date());
    await retrySlackLookups(getDb(), transports, new Date());
  });
  await boss.createQueue(QUEUES.reminders, { retryLimit: 3, retryDelay: 300, expireInSeconds: 600 });
  await boss.schedule(QUEUES.reminders, REMINDERS_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.reminders, async () => {
    const recorded = await recordReminders(getDb(), new Date());
    if (recorded > 0) logger.info({ recorded }, "reminders recorded");
  });
  await boss.send(QUEUES.reminders, {});

  channels.webhook = await setUpWebhookJobs(boss, {
    config: getWebhookConfig(),
    baseUrl: notificationConfig.LOGBUCH_BASE_URL,
    db: getDb,
  });

  const stopDispatcher = startDispatcher({ db: getDb(), transports, intervalMs: DISPATCH_INTERVAL_MS });

  const stopHeartbeat = startHeartbeat({
    db: getDb(),
    workerId: hostname(),
    file: envValue("WORKER_HEARTBEAT_FILE") ?? DEFAULT_HEARTBEAT_FILE,
    channels,
  });
  logger.info({ directory: directory.kind, channels }, "worker started");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker stopping");
    stopHeartbeat();
    await stopDispatcher();
    await boss.stop({ graceful: true, timeout: 20_000 });
    await getPool().end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "worker failed to start");
  Sentry.captureException(error);
  await Sentry.flush(2_000);
  process.exit(1);
});
