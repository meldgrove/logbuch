import { statSync } from "node:fs";
import { envValue } from "@/lib/env";
import { DEFAULT_HEARTBEAT_FILE, HEARTBEAT_INTERVAL_MS } from "./heartbeat-file";

// Container health check for the worker: the heartbeat file is fresh.
const file = envValue("WORKER_HEARTBEAT_FILE") ?? DEFAULT_HEARTBEAT_FILE;
const maxAgeMs = 3 * HEARTBEAT_INTERVAL_MS;

try {
  const age = Date.now() - statSync(file).mtimeMs;
  process.exit(age < maxAgeMs ? 0 : 1);
} catch {
  process.exit(1);
}
