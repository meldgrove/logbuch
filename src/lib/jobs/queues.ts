/** pg-boss queues and schedules. pg-boss keeps its tables in the `pgboss` schema. */
export const QUEUES = {
  directorySync: "directory-sync",
  proposalWatch: "proposal-watch",
  reminders: "reminders",
  webhookSync: "webhook-sync",
  webhookReconcile: "webhook-reconcile",
} as const;

/** Directory sync every 15 minutes (Keycloak directory). */
export const DIRECTORY_SYNC_CRON = "*/15 * * * *";

/** Readiness and lost access: every 5 minutes. */
export const PROPOSAL_WATCH_CRON = "*/5 * * * *";

/** Reminder emails at 09:00 in the server's time zone, Monday to Friday. */
export const REMINDERS_CRON = "0 9 * * 1-5";

/** Requested entries go to the webhook every minute. */
export const WEBHOOK_SYNC_CRON = "* * * * *";

/** The nightly correction re-sends every changed entry, at 02:30 in the server's time zone. */
export const WEBHOOK_RECONCILE_CRON = "30 2 * * *";

/** How often the worker looks for notifications to send. */
export const DISPATCH_INTERVAL_MS = 5_000;
