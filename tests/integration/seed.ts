import type { Database } from "@/lib/db/client";
import { person, tag, team } from "@/lib/db/schema";
import type { Actor } from "@/lib/entries/commands";

/** Two active teams, one inactive team, three people with access (one admin), one without. Managed in Logbuch, as with the manual directory. */
export async function seedDirectory(db: Database) {
  const [tech, ops, archive] = await db
    .insert(team)
    .values([
      { name: "Engineering" },
      { name: "Operations" },
      { name: "Archive", isActive: false },
    ])
    .returning();
  const people = await db
    .insert(person)
    .values([
      { oidcSubject: "sub-ada", displayName: "Ada Author", teamId: tech!.id, hasAccess: true },
      { oidcSubject: "sub-dan", displayName: "Dan Decider", teamId: ops!.id, hasAccess: true },
      { oidcSubject: "sub-amy", displayName: "Amy Admin", teamId: ops!.id, hasAccess: true, isAdmin: true },
      { oidcSubject: "sub-lea", displayName: "Lea Left", teamId: tech!.id, hasAccess: false },
    ])
    .returning();
  const [ada, dan, amy, lea] = people;
  const [budget, hiring, old] = await db
    .insert(tag)
    .values([{ name: "Budget" }, { name: "Tools" }, { name: "Old", isActive: false }])
    .returning();
  const actor = (p: typeof ada): Actor => ({ personId: p!.id, isAdmin: p!.isAdmin });
  return {
    teams: { tech: tech!, ops: ops!, archive: archive! },
    people: { ada: ada!, dan: dan!, amy: amy!, lea: lea! },
    tags: { budget: budget!, tools: hiring!, old: old! },
    actors: { ada: actor(ada), dan: actor(dan), amy: actor(amy) },
  };
}
