import type { Metadata } from "next";
import { ActionButton, InvitePersonForm, PersonForm } from "@/components/admin/directory-forms";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getDirectory } from "@/lib/directory/directory";
import { listPeople, listTeams } from "@/lib/directory/queries";
import { personChanges } from "@/lib/directory/rules";
import { actorOf } from "@/lib/form-actions";
import { invitePersonAction, setPersonAccessAction, setPersonAdminAction, updatePersonAction } from "../directory-actions";

export const metadata: Metadata = { title: "People" };

/**
 * Everyone Logbuch knows. With the manual directory, admins invite people,
 * change names and teams, and give or take away access and admin rights.
 * Nobody is deleted: people who leave keep their name on past entries.
 */
export default async function PeoplePage() {
  const user = await requireAdmin();
  const directory = getDirectory();
  const editable = directory.editable;
  const [people, teams] = await Promise.all([listPeople(getDb()), listTeams(getDb())]);
  const activeTeams = teams.filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name }));
  const adminsWithAccess = people.filter((p) => p.isAdmin && p.hasAccess).length;
  const changesOf = (p: (typeof people)[number]) => personChanges(directory, actorOf(user), p, adminsWithAccess);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="People"
        description={
          editable
            ? "Invited people get access at their first login with the same verified email address. People are never deleted; take away their access instead."
            : "People, teams, and admin rights come from Keycloak. Change them there; Logbuch syncs every 15 minutes."
        }
      />
      {editable ? (
        <Card role="region" aria-labelledby="invite">
          <CardHeader>
            <CardTitle>
              <h2 id="invite">Invite a person</h2>
            </CardTitle>
            <CardDescription>They sign in with the identity provider; Logbuch matches their verified email address once.</CardDescription>
          </CardHeader>
          <CardContent>
            <InvitePersonForm action={invitePersonAction} teams={activeTeams} />
          </CardContent>
        </Card>
      ) : null}
      <Card className="py-2">
        <CardContent className="px-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{editable ? "Name and team" : "Name"}</TableHead>
                {editable ? null : <TableHead>Team</TableHead>}
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                {editable ? (
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    Nobody yet.
                  </TableCell>
                </TableRow>
              ) : (
                people.map((p) => {
                  const changes = changesOf(p);
                  return (
                    <TableRow key={p.id}>
                      {changes.edit.ok ? (
                        <TableCell>
                          <PersonForm
                            action={updatePersonAction.bind(null, p.id)}
                            id={`person-${p.id}`}
                            name={p.displayName}
                            teamId={p.teamId}
                            teams={p.teamId && !activeTeams.some((t) => t.id === p.teamId) ? [...activeTeams, { id: p.teamId, name: p.teamName ?? "" }] : activeTeams}
                          />
                        </TableCell>
                      ) : (
                        <>
                          <TableCell className="font-medium">{p.displayName}</TableCell>
                          {editable ? null : <TableCell>{p.teamName ?? <span className="text-muted-foreground">No team</span>}</TableCell>}
                        </>
                      )}
                      <TableCell className="text-muted-foreground">{p.workEmail ?? "—"}</TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          {!p.hasAccess ? (
                            <Badge variant="outline">No access</Badge>
                          ) : p.hasLoggedIn ? (
                            <Badge variant="secondary">Active</Badge>
                          ) : (
                            <Badge variant="outline">Invited</Badge>
                          )}
                          {p.isAdmin ? <Badge>Admin</Badge> : null}
                        </span>
                      </TableCell>
                      {editable ? (
                        <TableCell>
                          {/* Changes the rules refuse are not offered: your own access, the last admin's rights. */}
                          <div className="flex flex-wrap gap-1">
                            {changes.admin.ok ? (
                              <ActionButton
                                action={setPersonAdminAction.bind(null, p.id, !p.isAdmin)}
                                label={p.isAdmin ? "Remove admin" : "Make admin"}
                              />
                            ) : null}
                            {changes.access.ok ? (
                              <ActionButton
                                action={setPersonAccessAction.bind(null, p.id, !p.hasAccess)}
                                label={p.hasAccess ? "Remove access" : "Give access"}
                              />
                            ) : null}
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
