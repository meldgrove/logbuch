import { PROPOSAL_BADGES } from "@/components/proposals/labels";
import { getCurrentPerson } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { TYPE_LABELS } from "@/lib/entries/constants";
import { searchEntries } from "@/lib/entries/queries";
import { entryPath, formatEntryRef } from "@/lib/entries/refs";
import type { SearchResult } from "@/lib/entries/search";
import type { ProposalStatus } from "@/lib/process/rules";

// The search in the sidebar (⌘K); it finds entries only. Answers 401 instead of redirecting.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  const person = await getCurrentPerson();
  if (!person) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 200);
  const entries = q ? await searchEntries(getDb(), q) : [];
  const results: SearchResult[] = entries.map((e) => ({
    ref: formatEntryRef(e.number),
    title: e.title,
    kind: e.isProposal ? PROPOSAL_BADGES[e.status as ProposalStatus] : TYPE_LABELS[e.type],
    href: entryPath(e.number),
  }));
  return Response.json({ results }, { headers: NO_STORE });
}
