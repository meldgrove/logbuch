import { ChevronRight, ListChecks } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { formatEntryRef } from "@/lib/entries/refs";
import { DEADLINE_END } from "@/lib/format";
import { getMyTasks } from "@/lib/process/queries";

export const metadata: Metadata = { title: "My tasks" };

export default async function TasksPage() {
  const { person } = await requireUser();
  const fmt = await getFormatter();
  const tasks = await getMyTasks(getDb(), person.id);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="My tasks" description="Drafts, proposals, and questions that wait for you." />
      {tasks.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListChecks aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>All done</EmptyTitle>
            <EmptyDescription>Nothing is waiting for you.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {tasks.map((task) => (
            <li key={task.key}>
              <Item asChild variant="outline">
                <Link href={task.href}>
                  <ItemContent>
                    <ItemTitle>{task.label}</ItemTitle>
                    <ItemDescription className="text-foreground">
                      {formatEntryRef(task.number)}: {task.title}
                    </ItemDescription>
                    {task.due ? <ItemDescription className="text-xs">Due {fmt.date(task.due)}, {DEADLINE_END}</ItemDescription> : null}
                  </ItemContent>
                  <ItemActions>
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  </ItemActions>
                </Link>
              </Item>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
