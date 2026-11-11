import type { ErrorEvent, NodeOptions } from "@sentry/node";
import type { ErrorReportingConfig } from "./config";

/**
 * Drizzle puts a failed query's values into the error message
 * ("Failed query: …\nparams: …"). They can hold entry text and email
 * addresses, so they never reach Sentry.
 */
export function withoutQueryParameters(message: string): string {
  return message.replace(/\nparams: [\s\S]*$/, "\nparams: [redacted]");
}

/**
 * pg-boss emits some errors as plain objects that copy every property of the
 * original error, such as Drizzle's `params`. Keeps only message and stack.
 */
export function asError(error: unknown): unknown {
  if (error instanceof Error || typeof error !== "object" || error === null) return error;
  const { message, stack } = error as { message?: unknown; stack?: unknown };
  const converted = new Error(String(message));
  if (typeof stack === "string") converted.stack = stack;
  return converted;
}

function redactEvent(event: ErrorEvent): ErrorEvent {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = withoutQueryParameters(exception.value);
  }
  if (event.message) event.message = withoutQueryParameters(event.message);
  return event;
}

/**
 * Options for `Sentry.init` in the web process and the worker, or `undefined`
 * while error reporting is off. Errors only, without personal data: no
 * tracing, no user, cookies, headers, bodies, query strings, local variables,
 * or breadcrumbs (they repeat console output and outgoing URLs).
 */
export function sentryOptions(config: ErrorReportingConfig, service: "web" | "worker"): NodeOptions | undefined {
  if (!config.SENTRY_DSN) return undefined;
  return {
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT,
    release: config.SENTRY_RELEASE,
    initialScope: { tags: { service } },
    maxBreadcrumbs: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
    },
    beforeSend: redactEvent,
  };
}
