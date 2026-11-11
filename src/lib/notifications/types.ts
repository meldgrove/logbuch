/*
 * Types shared by the schema, the planner, and the worker. No imports, so the
 * schema can use them without a cycle.
 */

/** A channel-neutral message. The worker formats it for Slack or email. */
export interface NotificationMessage {
  /** Email subject; also the first line of a Slack message's preview. */
  subject: string;
  /** Entry reference, e.g. "LB-12". */
  ref: string;
  title: string;
  /** What happened and what the recipient should do. */
  text: string;
  deadline?: { label: string; date: string };
  /** Path in Logbuch, e.g. "/e/LB-12". The worker adds the base URL. */
  path: string;
  /** Posts to the Slack channel: what the entry is about. */
  post?: ChannelPost;
}

/** Labels, not keys, so the worker formats the post as it was recorded. */
export interface ChannelPost {
  /** "Update", "Decision", or "Learning". */
  type: string;
  summary: string;
  /** "Small", "Medium", "Large", or "Not set". */
  impact: string;
  mustRead: boolean;
  affectedTeams: string[];
}

/** How the worker sends each channel: for real, to the log, or not at all. */
export type ChannelMode = "live" | "console" | "off";

export interface NotificationChannels {
  slack: ChannelMode;
  /** Posts to the Slack channel: needs Slack and SLACK_CHANNEL_ID. */
  slackChannel?: ChannelMode;
  email: ChannelMode;
  /** The webhook: live or off. */
  webhook?: ChannelMode;
}
