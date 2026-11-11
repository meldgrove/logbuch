import type { Database } from "@/lib/db/client";
import type { Directory } from "@/lib/directory/directory";
import { findPersonBySubject } from "@/lib/directory/queries";

/** Error code the login flow uses when someone has no access to Logbuch. */
export const NO_ACCESS_ERROR_CODE = "NO_ACCESS";

export interface LoginAccessOptions {
  directory: Directory;
  /** Treat the provider's email addresses as verified (OIDC_TRUST_EMAIL). */
  trustEmail?: boolean;
  now?: Date;
}

/** A login: the Better Auth user and the OIDC `sub` it logged in with. */
export interface Login {
  userId: string;
  subject: string;
}

/**
 * Decides whether a login may get a session. The OIDC `sub` must belong to a
 * person with access. For anyone else the directory decides: the
 * manual directory links an invitation at the first login, the Keycloak
 * directory syncs once and looks again.
 */
export async function hasLoginAccess(db: Database, { userId, subject }: Login, options: LoginAccessOptions): Promise<boolean> {
  const known = await findPersonBySubject(db, subject);
  if (known?.hasAccess) return true;
  return options.directory.admitNewLogin(db, {
    userId,
    subject,
    known: known !== undefined,
    trustEmail: options.trustEmail ?? false,
    now: options.now ?? new Date(),
  });
}
