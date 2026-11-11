/**
 * Reads an operational setting (LOG_LEVEL, LOGBUCH_PROCESS,
 * WORKER_HEARTBEAT_FILE, MIGRATIONS_DIR). Blank values count as unset,
 * because some platforms pass unset variables as "". Application settings go
 * through `src/lib/config.ts` instead. Free of imports, so the worker health
 * check stays small.
 */
export function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
