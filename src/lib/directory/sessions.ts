import { inArray } from "drizzle-orm";
import type { Database, Transaction } from "@/lib/db/client";
import { authSession } from "@/lib/db/schema";

/** Better Auth's provider ID of the OIDC login; also the last segment of the callback URL. */
export const OIDC_PROVIDER_ID = "oidc";

/** Ends every session that logged in with one of these OIDC subjects. Returns how many ended. */
export async function endSessionsForSubjects(tx: Database | Transaction, subjects: string[]): Promise<number> {
  if (subjects.length === 0) return 0;
  const deleted = await tx
    .delete(authSession)
    .where(inArray(authSession.oidcSubject, subjects))
    .returning({ id: authSession.id });
  return deleted.length;
}
