import type { ErrorEvent } from "@sentry/node";
import { describe, expect, it } from "vitest";
import { asError, sentryOptions, withoutQueryParameters } from "./error-reporting";

const dsn = "https://key@o1.ingest.example.org/2";

describe("sentryOptions", () => {
  it("is off without a DSN", () => {
    expect(sentryOptions({}, "web")).toBeUndefined();
  });

  it("reports errors only, without personal data", () => {
    const options = sentryOptions({ SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: "staging", SENTRY_RELEASE: "abc123" }, "worker");
    expect(options).toMatchObject({
      dsn,
      environment: "staging",
      release: "abc123",
      initialScope: { tags: { service: "worker" } },
      maxBreadcrumbs: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        databaseQueryData: false,
        stackFrameVariables: false,
      },
    });
    expect(options?.tracesSampleRate).toBeUndefined();
  });

  it("removes query values from database errors before sending", () => {
    const beforeSend = sentryOptions({ SENTRY_DSN: dsn }, "web")?.beforeSend;
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          { type: "DrizzleQueryError", value: 'Failed query: insert into "entry" ("title") values ($1)\nparams: Secret plan,erika@example.org' },
          { type: "DatabaseError", value: "duplicate key value violates unique constraint" },
        ],
      },
    };
    const sent = beforeSend?.(event, {}) as ErrorEvent;
    expect(sent.exception?.values?.map((exception) => exception.value)).toEqual([
      'Failed query: insert into "entry" ("title") values ($1)\nparams: [redacted]',
      "duplicate key value violates unique constraint",
    ]);
  });
});

describe("asError", () => {
  it("turns pg-boss's plain error objects into errors with only message and stack", () => {
    const original = Object.assign(new Error("Failed query: select 1\nparams: erika@example.org"), { params: ["erika@example.org"] });
    const emitted = { ...original, message: original.message, stack: original.stack, queue: "reminders" };
    const error = asError(emitted);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: original.message, stack: original.stack });
    expect(Object.keys(error as Error)).toEqual([]);
  });

  it("leaves errors as they are", () => {
    const error = new Error("boom");
    expect(asError(error)).toBe(error);
  });
});

describe("withoutQueryParameters", () => {
  it("keeps messages without query values", () => {
    expect(withoutQueryParameters("connect ECONNREFUSED 127.0.0.1:5432")).toBe("connect ECONNREFUSED 127.0.0.1:5432");
  });

  it("removes values over several lines", () => {
    expect(withoutQueryParameters("Failed query: select 1\nparams: a\nb")).toBe("Failed query: select 1\nparams: [redacted]");
  });
});
