import { z } from "zod";
import { getCurrentPerson } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { searchEntriesForPicker } from "@/lib/entries/queries";
import { formatEntryRef } from "@/lib/entries/refs";

// Entry picker search for the forms. Answers 401 instead of redirecting.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const person = await getCurrentPerson();
  if (!person) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const params = new URL(request.url).searchParams;
  // Only a well-formed UUID reaches the database; anything else is ignored.
  const exclude = z.uuid().safeParse(params.get("exclude"));
  const entries = await searchEntriesForPicker(getDb(), {
    q: (params.get("q") ?? "").slice(0, 200),
    supersedable: params.get("mode") === "supersedes",
    excludeId: exclude.success ? exclude.data : undefined,
  });
  return Response.json(
    { entries: entries.map((e) => ({ id: e.id, label: `${formatEntryRef(e.number)}: ${e.title}` })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
