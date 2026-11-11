import { getPool } from "@/lib/db/client";
import { checkReadiness } from "@/lib/health/readiness";
import { logger } from "@/lib/logger";

// Readiness: the database is reachable and all migrations are applied.
// The Compose health check of `web` uses this endpoint.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await checkReadiness(getPool());
  if (!result.ready) logger.warn({ checks: result.checks, error: result.error }, "not ready");
  return Response.json(
    { status: result.ready ? "ready" : "not_ready", checks: result.checks },
    { status: result.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
