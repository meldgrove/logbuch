import { ChevronRight, MessagesSquare, NotebookPen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NoTeamsNotice } from "@/components/entries/no-teams-notice";
import { PageHeader } from "@/components/page-header";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getDirectory } from "@/lib/directory/directory";
import { hasActiveTeam } from "@/lib/directory/queries";

export const metadata: Metadata = { title: "New entry" };

const choices = [
  {
    href: "/new/log",
    title: "Log something",
    description: "An update, a decision already made, or a learning. It is published right away.",
    icon: NotebookPen,
  },
  {
    href: "/new/proposal",
    title: "Start a proposal",
    description:
      "Ask for a decision through the decision process: feedback, an objection round, and a published decision. Two-way or one-way.",
    icon: MessagesSquare,
  },
];

/** Two ways to create an entry. */
export default async function NewEntryPage() {
  const { person } = await requireUser();
  if (!(await hasActiveTeam(getDb()))) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <PageHeader title="New entry" description="Log what already happened, or ask for a decision." />
        <NoTeamsNotice isAdmin={person.isAdmin} editable={getDirectory().editable} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="New entry" description="Log what already happened, or ask for a decision." />
      <ul className="grid gap-4 sm:grid-cols-2">
        {choices.map((choice) => (
          <li key={choice.href} className="flex">
            <Item asChild variant="outline" className="flex-1 flex-nowrap items-start">
              <Link href={choice.href}>
                <ItemMedia variant="icon">
                  <choice.icon aria-hidden="true" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="text-base">{choice.title}</ItemTitle>
                  <ItemDescription className="line-clamp-none">{choice.description}</ItemDescription>
                </ItemContent>
                <ItemActions className="self-center">
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                </ItemActions>
              </Link>
            </Item>
          </li>
        ))}
      </ul>
    </div>
  );
}
