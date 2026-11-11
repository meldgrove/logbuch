// Liveness: the process answers. No dependency checks, so a database outage
// never causes restart loops.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
