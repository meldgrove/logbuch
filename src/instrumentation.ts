import * as Sentry from "@sentry/nextjs";

// Runs once when the server starts. Invalid configuration stops the process
// instead of failing later on the first request.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getErrorReportingConfig, validateWebConfig } = await import("@/lib/config");
    validateWebConfig();
    const { sentryOptions } = await import("@/lib/error-reporting");
    const options = sentryOptions(getErrorReportingConfig(), "web");
    if (options) Sentry.init(options);
  }
}

// Errors in pages, Server Actions, and route handlers. Does nothing while
// error reporting is off.
export const onRequestError = Sentry.captureRequestError;
