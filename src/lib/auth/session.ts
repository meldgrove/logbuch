import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/lib/db/client";
import { authSession } from "@/lib/db/schema";
import { findPersonBySubject, type PersonRow } from "@/lib/directory/queries";
import { createDateFormatter, type DateFormatter } from "@/lib/format";
import { recordActivity } from "@/lib/measures/activity";
import { displayPreferences } from "@/lib/preferences";
import { getAuth } from "./auth";

export interface CurrentUser {
  userId: string;
  person: PersonRow;
}

/**
 * Session and person for this request. Cached per request. The person is the
 * one of the `sub` the session logged in with.
 */
const loadRequestUser = cache(async () => {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const person = await findPersonBySubject(getDb(), session.session.oidcSubject);
  return { session, person };
});

/** The person behind this request if they have access, without redirecting (for route handlers). */
export async function getCurrentPerson(): Promise<PersonRow | null> {
  const loaded = await loadRequestUser();
  return loaded?.person?.hasAccess ? loaded.person : null;
}

/** True when the request has a session, with or without access. */
export async function hasSession(): Promise<boolean> {
  return (await loadRequestUser()) !== null;
}

/**
 * How dates and times are shown to the person behind this request: their own
 * time zone and date format, or the defaults.
 */
export const getFormatter = cache(async (): Promise<DateFormatter> => {
  const loaded = await loadRequestUser();
  return createDateFormatter(displayPreferences(loaded?.person));
});

/**
 * Every page, Server Action, and route handler calls this (or
 * `requireAdmin`). It checks the access flag in the database on each request
 * and notes the month as active for the person.
 */
export async function requireUser(): Promise<CurrentUser> {
  const loaded = await loadRequestUser();
  if (!loaded) redirect("/login");
  if (!loaded.person?.hasAccess) {
    // Access ended after login (the sync normally ends these sessions first).
    await getDb().delete(authSession).where(eq(authSession.id, loaded.session.session.id));
    redirect("/no-access");
  }
  await recordActivity(getDb(), loaded.person.id);
  return { userId: loaded.session.user.id, person: loaded.person };
}

/** Like `requireUser`, and the person must be a Logbuch admin. */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.person.isAdmin) notFound();
  return user;
}
