import type { Actor } from "@/lib/entries/commands";
import type { Directory } from "./directory";

/*
 * What an admin may change about people and teams, and why not. The commands
 * in manage.ts enforce these answers; the People and Teams pages ask them
 * what to offer.
 */

export interface Check {
  ok: boolean;
  reason?: string;
  /** The actor may not change people or teams here at all, as opposed to this change being invalid. */
  forbidden?: boolean;
}

const ok: Check = { ok: true };
const forbidden = (reason: string): Check => ({ ok: false, reason, forbidden: true });
const invalid = (reason: string): Check => ({ ok: false, reason });

const LAST_ADMIN = "This is the last admin. Make someone else an admin first.";

/**
 * Inviting people and creating, renaming, activating, or deactivating teams:
 * admins, in a directory managed in Logbuch. People and teams synced from
 * Keycloak earlier can be changed too, once the directory is manual.
 */
export function directoryChange(directory: Pick<Directory, "editable">, actor: Actor): Check {
  if (!actor.isAdmin) return forbidden("Only admins can manage people and teams.");
  if (!directory.editable) return forbidden("People and teams come from Keycloak. Change them there.");
  return ok;
}

export interface PersonChanges {
  /** Name and team. */
  edit: Check;
  /** Taking access away, or giving it back. */
  access: Check;
  /** Making the person an admin, or taking admin rights away. */
  admin: Check;
}

/**
 * What an admin may change about one person. Nobody takes away their own
 * access, only people with access become admins, and the last admin keeps
 * access and admin rights. `adminsWithAccess` counts every admin with access,
 * the person included.
 */
export function personChanges(
  directory: Pick<Directory, "editable">,
  actor: Actor,
  target: { id: string; hasAccess: boolean; isAdmin: boolean },
  adminsWithAccess: number,
): PersonChanges {
  const base = directoryChange(directory, actor);
  if (!base.ok) return { edit: base, access: base, admin: base };
  const lastAdmin = target.hasAccess && target.isAdmin && adminsWithAccess <= 1;

  let access = ok;
  if (target.hasAccess && target.id === actor.personId) access = invalid("You cannot take away your own access.");
  else if (lastAdmin) access = invalid(LAST_ADMIN);

  let admin = ok;
  if (!target.isAdmin && !target.hasAccess) admin = invalid("Give this person access first.");
  else if (lastAdmin) admin = invalid(LAST_ADMIN);

  return { edit: ok, access, admin };
}
