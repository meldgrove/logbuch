import pino from "pino";
import { envValue } from "./env";

/** JSON logs to stdout, for the container logs. */
export const logger = pino({
  level: envValue("LOG_LEVEL") ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: envValue("LOGBUCH_PROCESS") ?? "web" },
  redact: {
    paths: ["*.password", "*.secret", "*.token", "*.accessToken", "*.refreshToken", "*.idToken", "*.authorization"],
    censor: "[redacted]",
  },
});

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
