import { getVersionConfig } from "@/lib/config";

// Liveness: the process answers. No dependency checks, so a database outage
// never causes restart loops. The version is null in images built from source.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { status: "ok", version: getVersionConfig().APP_VERSION ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
