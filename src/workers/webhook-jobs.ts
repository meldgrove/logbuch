import type { PgBoss } from "pg-boss";
import type { WebhookConfig } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import { SERVER_TIME_ZONE } from "@/lib/format";
import { QUEUES, WEBHOOK_RECONCILE_CRON, WEBHOOK_SYNC_CRON } from "@/lib/jobs/queues";
import { logger } from "@/lib/logger";
import type { ChannelMode } from "@/lib/notifications/types";
import { createWebhookClient, type WebhookClient } from "@/lib/webhooks/client";
import { reconcileWebhook, syncRequested } from "@/lib/webhooks/sync";

type Boss = Pick<PgBoss, "createQueue" | "schedule" | "unschedule" | "work" | "send" | "getQueue" | "deleteQueuedJobs">;

const WEBHOOK_QUEUES = [QUEUES.webhookSync, QUEUES.webhookReconcile] as const;

/**
 * Webhook jobs: requested entries every minute, every changed entry nightly
 * and once at startup. Without WEBHOOK_URL the webhook is off; requests then
 * wait until it is set. pg-boss keeps schedules in the database, so turning
 * the webhook off also removes them and drops jobs no worker would run.
 */
export async function setUpWebhookJobs(
  boss: Boss,
  options: {
    config: WebhookConfig;
    baseUrl: string;
    db: () => Database;
    createClient?: (config: Parameters<typeof createWebhookClient>[0]) => WebhookClient;
  },
): Promise<ChannelMode> {
  const { config } = options;
  if (!config.WEBHOOK_URL || !config.WEBHOOK_SECRET) {
    for (const name of WEBHOOK_QUEUES) {
      await boss.unschedule(name);
      if (await boss.getQueue(name)) await boss.deleteQueuedJobs(name);
    }
    return "off";
  }

  const client = (options.createClient ?? createWebhookClient)({ url: config.WEBHOOK_URL, secret: config.WEBHOOK_SECRET });
  await boss.createQueue(QUEUES.webhookSync, { retryLimit: 0, expireInSeconds: 300 });
  await boss.schedule(QUEUES.webhookSync, WEBHOOK_SYNC_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.webhookSync, async () => {
    const counts = await syncRequested(options.db(), client, options.baseUrl, new Date());
    if (counts.sent + counts.failed > 0) logger.info(counts, "webhook sync");
  });
  await boss.createQueue(QUEUES.webhookReconcile, { retryLimit: 2, retryDelay: 600, expireInSeconds: 3_600 });
  await boss.schedule(QUEUES.webhookReconcile, WEBHOOK_RECONCILE_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.webhookReconcile, async () => {
    logger.info(await reconcileWebhook(options.db(), client, options.baseUrl, new Date()), "webhook reconciliation");
  });
  await boss.send(QUEUES.webhookReconcile, {});
  return "live";
}
