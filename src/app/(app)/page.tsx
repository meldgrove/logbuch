import { ChevronLeft, ChevronRight, Plus, ScrollText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EntryCard } from "@/components/entries/entry-card";
import { ActiveFilterList, TimelineFilterMenu } from "@/components/entries/timeline-filter-bar";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getFilterOptions, listTimeline, parseTimelineFilters } from "@/lib/entries/queries";
import { timelineHref } from "@/lib/entries/timeline-filters";

export const metadata: Metadata = { title: "Timeline" };

export default async function TimelinePage({ searchParams }: PageProps<"/">) {
  // Layouts are not re-rendered on every navigation, so each page checks access.
  await requireUser();
  const filters = parseTimelineFilters(await searchParams);
  const db = getDb();
  const [timeline, options] = await Promise.all([listTimeline(db, filters), getFilterOptions(db)]);
  const filtered = Object.entries(filters).some(([key, value]) => key !== "page" && value !== undefined);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Timeline"
        description="Updates, decisions, and learnings from every team, newest first."
        actions={
          <>
            {/* Keyed by the URL: chips, links, and the back button change the filters too. */}
            <TimelineFilterMenu key={timelineHref(filters)} filters={filters} options={options} />
            <Button asChild>
              <Link href="/new">
                <Plus aria-hidden="true" />
                New entry
              </Link>
            </Button>
          </>
        }
      />

      <ActiveFilterList filters={filters} options={options} />

      {timeline.items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollText aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{filtered ? "No entries found" : "No entries yet"}</EmptyTitle>
            <EmptyDescription>
              {filtered ? "No entries match these filters." : "No entries yet. Log the first update, decision, or learning."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Entries">
          {timeline.items.map((item) => (
            <li key={item.id}>
              <EntryCard item={item} />
            </li>
          ))}
        </ol>
      )}

      {timeline.page > 1 || timeline.hasMore ? (
        <nav aria-label="Pages" className="flex justify-between">
          {timeline.page > 1 ? (
            <Button asChild variant="outline">
              <Link href={timelineHref(filters, timeline.page - 1)}>
                <ChevronLeft aria-hidden="true" />
                Newer entries
              </Link>
            </Button>
          ) : (
            <span />
          )}
          {timeline.hasMore ? (
            <Button asChild variant="outline">
              <Link href={timelineHref(filters, timeline.page + 1)}>
                Older entries
                <ChevronRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
