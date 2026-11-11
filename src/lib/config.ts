import { z } from "zod";

/**
 * Environment configuration, validated with zod.
 *
 * Each process validates only what it needs: `migrate` needs the database,
 * the worker also needs the directory, notifications, and the webhook, and
 * the web process needs the database, login, and the directory. Empty strings
 * count as unset, because some platforms pass unset variables as "".
 */

type Env = Record<string, string | undefined>;

const blankAsUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** A variable that must be set; when it is not, the error says so instead of naming types. */
const required = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankAsUndefined, z.any().refine((value) => value !== undefined, { message: "is required", abort: true }).pipe(schema));
const requiredString = () => required(z.string().min(1));
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankAsUndefined, schema.optional());

const httpUrl = z.url({ protocol: /^https?$/ });
const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/** The value of BETTER_AUTH_SECRET in `.env.example`, refused in production. */
const EXAMPLE_SECRET = "development-secret-development-secret";

/** A Keycloak group path such as "/logbuch" or "/staff/logbuch". */
const groupPath = z.string().regex(/^\/[^/].*[^/]$|^\/[^/]$/, 'must be a group path such as "/logbuch"');

/** A list of email addresses, separated by commas, semicolons, or spaces. Lower-cased. */
const emailList = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value
          .split(/[\s,;]+/)
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
      : [],
  z.array(z.email()),
);

/** "true" or "false"; unset means `fallback`. */
const flag = (fallback: boolean) =>
  z.preprocess(blankAsUndefined, z.enum(["true", "false"], { error: 'must be "true" or "false"' }).optional()).transform((value) =>
    value === undefined ? fallback : value === "true",
  );

/**
 * Fills in defaults for unset or blank variables. The Keycloak directory uses
 * the login client unless it has its own.
 */
function withDefaults(env: Env): Env {
  const value = (name: string) => blankAsUndefined(env[name]) as string | undefined;
  return {
    ...env,
    DIRECTORY: value("DIRECTORY") ?? "manual",
    OIDC_SCOPES: value("OIDC_SCOPES") ?? "openid profile email",
    KEYCLOAK_CLIENT_ID: value("KEYCLOAK_CLIENT_ID") ?? value("OIDC_CLIENT_ID"),
    KEYCLOAK_CLIENT_SECRET: value("KEYCLOAK_CLIENT_SECRET") ?? value("OIDC_CLIENT_SECRET"),
    // Production sends for real; development and tests only log.
    NOTIFICATION_TRANSPORT: value("NOTIFICATION_TRANSPORT") ?? (env.NODE_ENV === "production" ? "live" : "console"),
    MAIL_FROM_NAME: value("MAIL_FROM_NAME") ?? "Logbuch",
  };
}

const databaseSchema = z.object({
  DATABASE_URL: required(z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL")),
});

const authSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    LOGBUCH_BASE_URL: required(httpUrl.transform(withoutTrailingSlash)),
    BETTER_AUTH_SECRET: required(z.string().min(32, "must be at least 32 characters")),
    OIDC_ISSUER: required(httpUrl.transform(withoutTrailingSlash)),
    OIDC_CLIENT_ID: requiredString(),
    OIDC_CLIENT_SECRET: requiredString(),
    OIDC_SCOPES: requiredString(),
    /**
     * Treat every email address from the provider as verified. Only for
     * providers that do not send `email_verified` (e.g. Microsoft Entra ID)
     * and whose users cannot choose their own address.
     */
    OIDC_TRUST_EMAIL: flag(false),
  })
  .refine((env) => env.NODE_ENV !== "production" || env.BETTER_AUTH_SECRET !== EXAMPLE_SECRET, {
    message: "is the example value from .env.example; generate one with `openssl rand -base64 32`",
    path: ["BETTER_AUTH_SECRET"],
  })
  .transform(({ NODE_ENV: _, ...config }) => config);

/**
 * Where people, teams, and access come from:
 *
 * - `manual`: admins invite people and manage teams in Logbuch. While there
 *   is no admin, the first login with an address in INITIAL_ADMIN_EMAILS
 *   becomes one; without that list nobody could ever get in.
 * - `keycloak`: a sync reads the members of Keycloak groups through the
 *   Keycloak Admin API. Every entry belongs to a team, and teams, tags, and
 *   stuck proposals need admins, so all three groups are required.
 */
const directorySchema = z.discriminatedUnion("DIRECTORY", [
  z.object({
    DIRECTORY: z.literal("manual"),
    INITIAL_ADMIN_EMAILS: emailList.refine((emails) => emails.length > 0, {
      message: "is required with DIRECTORY=manual: list the email addresses of the first admins",
    }),
  }),
  z.object({
    DIRECTORY: z.literal("keycloak"),
    OIDC_ISSUER: required(
      httpUrl
        .transform(withoutTrailingSlash)
        .refine((url) => /\/realms\/[^/]+$/.test(url), "must be a Keycloak realm URL ending in /realms/<realm>"),
    ),
    KEYCLOAK_CLIENT_ID: requiredString(),
    KEYCLOAK_CLIENT_SECRET: requiredString(),
    KEYCLOAK_ACCESS_GROUP: required(groupPath),
    KEYCLOAK_ADMIN_GROUP: required(groupPath),
    KEYCLOAK_TEAMS_GROUP: required(groupPath),
  }),
]);

/**
 * Notifications. Slack and email are each optional: a channel without its
 * settings is off. Email goes through SMTP or MailerSend.
 */
const notificationSchema = z
  .object({
    NOTIFICATION_TRANSPORT: z.enum(["live", "console"]),
    LOGBUCH_BASE_URL: required(httpUrl.transform(withoutTrailingSlash)),
    SLACK_BOT_TOKEN: optional(z.string().startsWith("xoxb-", "must be a Slack bot token (xoxb-…)")),
    /** The Slack channel for one post per new entry. */
    SLACK_CHANNEL_ID: optional(z.string().regex(/^[CG][A-Z0-9]{6,}$/, "must be a Slack channel ID (C…), not a name")),
    SMTP_URL: optional(z.url({ protocol: /^smtps?$/, error: "must be an smtp:// or smtps:// URL" })),
    MAILERSEND_API_TOKEN: optional(z.string().min(1)),
    MAIL_FROM: optional(z.email()),
    MAIL_FROM_NAME: requiredString(),
  })
  .refine((env) => !(env.SMTP_URL && env.MAILERSEND_API_TOKEN), {
    message: "set either SMTP_URL or MAILERSEND_API_TOKEN, not both",
    path: ["MAILERSEND_API_TOKEN"],
  })
  .refine((env) => !(env.SMTP_URL || env.MAILERSEND_API_TOKEN) || env.MAIL_FROM, {
    message: "is required to send email",
    path: ["MAIL_FROM"],
  });

/** The webhook: off until WEBHOOK_URL is set; then the signing secret is required. */
const webhookSchema = z
  .object({
    WEBHOOK_URL: optional(httpUrl),
    WEBHOOK_SECRET: optional(z.string().min(16, "must be at least 16 characters")),
  })
  .refine((env) => !env.WEBHOOK_URL || env.WEBHOOK_SECRET, {
    message: "is required with WEBHOOK_URL",
    path: ["WEBHOOK_SECRET"],
  });

/** Error reporting to Sentry: off until SENTRY_DSN is set. */
const errorReportingSchema = z.object({
  SENTRY_DSN: optional(httpUrl),
  SENTRY_ENVIRONMENT: optional(z.string()),
  SENTRY_RELEASE: optional(z.string()),
});

export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type AuthConfig = z.infer<typeof authSchema>;
export type DirectoryConfig = z.infer<typeof directorySchema>;
export type KeycloakDirectoryConfig = Extract<DirectoryConfig, { DIRECTORY: "keycloak" }>;
export type NotificationConfig = z.infer<typeof notificationSchema>;
export type WebhookConfig = z.infer<typeof webhookSchema>;
export type ErrorReportingConfig = z.infer<typeof errorReportingSchema>;

export class ConfigError extends Error {
  constructor(issues: z.core.$ZodIssue[]) {
    const lines = issues.map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    super(`Invalid environment configuration:\n${lines.join("\n")}`);
    this.name = "ConfigError";
  }
}

function parse<T extends z.ZodType>(schema: T, env: Env): z.infer<T> {
  const result = schema.safeParse(withDefaults(env));
  if (!result.success) throw new ConfigError(result.error.issues);
  return result.data;
}

export function parseDatabaseConfig(env: Env = process.env): DatabaseConfig {
  return parse(databaseSchema, env);
}

export function parseAuthConfig(env: Env = process.env): AuthConfig {
  return parse(authSchema, env);
}

export function parseDirectoryConfig(env: Env = process.env): DirectoryConfig {
  return parse(directorySchema, env);
}

export function parseNotificationConfig(env: Env = process.env): NotificationConfig {
  return parse(notificationSchema, env);
}

export function parseWebhookConfig(env: Env = process.env): WebhookConfig {
  return parse(webhookSchema, env);
}

export function parseErrorReportingConfig(env: Env = process.env): ErrorReportingConfig {
  return parse(errorReportingSchema, env);
}

function validate(schemas: readonly z.ZodType[], env: Env): void {
  const issues: z.core.$ZodIssue[] = [];
  const withDefaultValues = withDefaults(env);
  for (const schema of schemas) {
    const result = schema.safeParse(withDefaultValues);
    if (!result.success) issues.push(...result.error.issues);
  }
  if (issues.length > 0) throw new ConfigError(issues);
}

/** Validates every variable the web process needs. Called once at startup. */
export function validateWebConfig(env: Env = process.env): void {
  validate([databaseSchema, authSchema, directorySchema, errorReportingSchema], env);
}

/** Validates every variable the worker needs. */
export function validateWorkerConfig(env: Env = process.env): void {
  validate([databaseSchema, directorySchema, notificationSchema, webhookSchema, errorReportingSchema], env);
}

let databaseConfig: DatabaseConfig | undefined;
let authConfig: AuthConfig | undefined;
let directoryConfig: DirectoryConfig | undefined;
let notificationConfig: NotificationConfig | undefined;
let webhookConfig: WebhookConfig | undefined;
let errorReportingConfig: ErrorReportingConfig | undefined;

export function getDatabaseConfig(): DatabaseConfig {
  databaseConfig ??= parseDatabaseConfig();
  return databaseConfig;
}

export function getAuthConfig(): AuthConfig {
  authConfig ??= parseAuthConfig();
  return authConfig;
}

export function getDirectoryConfig(): DirectoryConfig {
  directoryConfig ??= parseDirectoryConfig();
  return directoryConfig;
}

export function getNotificationConfig(): NotificationConfig {
  notificationConfig ??= parseNotificationConfig();
  return notificationConfig;
}

export function getWebhookConfig(): WebhookConfig {
  webhookConfig ??= parseWebhookConfig();
  return webhookConfig;
}

export function getErrorReportingConfig(): ErrorReportingConfig {
  errorReportingConfig ??= parseErrorReportingConfig();
  return errorReportingConfig;
}
