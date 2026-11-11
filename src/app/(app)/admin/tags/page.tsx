import type { Metadata } from "next";
import { TagActiveForm, TagNameForm } from "@/components/entries/tag-forms";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { listTagsWithUsage } from "@/lib/entries/queries";
import { createTagAction, renameTagAction, setTagActiveAction } from "./actions";

export const metadata: Metadata = { title: "Tags" };

/** Tags are an admin-managed list. They are never deleted, only deactivated. */
export default async function TagsPage() {
  await requireAdmin();
  const tags = await listTagsWithUsage(getDb());
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Tags" description="Tags are never deleted. A deactivated tag stays on existing entries but cannot be chosen for new ones." />
      <Card role="region" aria-labelledby="new-tag">
        <CardHeader>
          <CardTitle>
            <h2 id="new-tag">New tag</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TagNameForm action={createTagAction} id="new-tag-name" label="Name of the new tag" submitLabel="Add tag" clearOnSuccess />
        </CardContent>
      </Card>
      <Card className="py-2">
        <CardContent className="px-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Entries</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tags.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No tags yet.
                  </TableCell>
                </TableRow>
              ) : (
                tags.map((tag) => (
                  <TableRow key={tag.id}>
                    <TableCell>
                      <TagNameForm
                        action={renameTagAction.bind(null, tag.id)}
                        id={`tag-${tag.id}`}
                        label={`Rename ${tag.name}`}
                        defaultValue={tag.name}
                        submitLabel="Rename"
                      />
                    </TableCell>
                    <TableCell className="text-right">{tag.entries}</TableCell>
                    <TableCell>
                      <Badge variant={tag.isActive ? "secondary" : "outline"}>{tag.isActive ? "Active" : "Inactive"}</Badge>
                    </TableCell>
                    <TableCell>
                      <TagActiveForm action={setTagActiveAction.bind(null, tag.id, !tag.isActive)} isActive={tag.isActive} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
