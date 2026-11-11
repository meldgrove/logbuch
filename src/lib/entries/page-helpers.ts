import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getEntryByNumber } from "./queries";
import { parseEntryRef } from "./refs";

/** Loads the entry for a /e/[ref] route, or shows the 404 page. Drafts only for their author. */
export async function loadEntry(ref: string, viewerId: string) {
  const number = parseEntryRef(decodeURIComponent(ref));
  if (!number) notFound();
  const found = await getEntryByNumber(getDb(), number, viewerId);
  if (!found) notFound();
  return found;
}
