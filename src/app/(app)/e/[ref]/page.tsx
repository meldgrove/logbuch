import { History, Pencil } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Addenda, EntryBadges, EntryFacts, Fact, SupersedeNotes } from "@/components/entries/entry-parts";
import { ProposalPage } from "@/components/proposals/proposal-page";
import { Markdown } from "@/components/markdown";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { canAddAddendum, canChangeImpact } from "@/lib/entries/commands";
import { HOW_DECIDED_LABELS, NOT_SET, REVERSIBILITY_LABELS } from "@/lib/entries/constants";
import { loadEntry } from "@/lib/entries/page-helpers";
import { getFormOptions } from "@/lib/entries/queries";
import { getProposalView } from "@/lib/process/queries";
import { entryPath, formatEntryRef } from "@/lib/entries/refs";

export async function generateMetadata({ params }: PageProps<"/e/[ref]">): Promise<Metadata> {
  const { ref } = await params;
  return { title: decodeURIComponent(ref).toUpperCase() };
}

export default async function EntryPage({ params }: PageProps<"/e/[ref]">) {
  const { person } = await requireUser();
  const fmt = await getFormatter();
  const entry = await loadEntry((await params).ref, person.id);
  const db = getDb();
  const actor = { personId: person.id, isAdmin: person.isAdmin };
  const [mayAddAddendum, mayChangeImpact] = await Promise.all([canAddAddendum(db, actor, entry.id), canChangeImpact(db, actor, entry.id)]);

  if (entry.isProposal) {
    const options = await getFormOptions(db);
    const view = await getProposalView(
      db,
      entry.id,
      actor,
      options.people.map((p) => p.id),
    );
    if (!view) notFound();
    return (
      <ProposalPage
        entry={entry}
        view={view}
        people={options.people}
        viewerId={person.id}
        mayAddAddendum={mayAddAddendum}
        mayChangeImpact={mayChangeImpact}
      />
    );
  }

  const isDecision = entry.type === "decision";
  const mayEdit = !isDecision && entry.authorId === person.id;
  const { decision, outcome } = entry;

  return (
    <article className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title={entry.title}
        eyebrow={
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <EntryBadges type={entry.type} impact={entry.impact} reversibility={decision?.reversibility} superseded={Boolean(entry.supersededBy)} />
            <span className="text-xs text-muted-foreground tabular-nums">{formatEntryRef(entry.number)}</span>
          </div>
        }
        description={
          <>
            {entry.teamName} · by {entry.authorName} · {fmt.published(entry.publishedAt, entry.imported)}
            {entry.editedAt ? ` · edited ${fmt.dateTime(entry.editedAt)}` : null}
          </>
        }
        actions={
          <>
            {mayEdit ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`${entryPath(entry.number)}/edit`}>
                  <Pencil aria-hidden="true" />
                  Edit
                </Link>
              </Button>
            ) : null}
            <Button asChild size="sm" variant="ghost">
              <Link href={`${entryPath(entry.number)}/history`}>
                <History aria-hidden="true" />
                History
              </Link>
            </Button>
          </>
        }
      />

      <SupersedeNotes entry={entry} />

      <p className="text-base">{entry.summary}</p>

      {entry.body ? (
        <section aria-labelledby="details" className="flex flex-col gap-2">
          <h2 id="details" className="text-lg font-semibold">
            {isDecision ? "Context" : "Details"}
          </h2>
          <Markdown>{entry.body}</Markdown>
        </section>
      ) : null}

      {isDecision && outcome ? (
        <section aria-labelledby="decision" className="flex flex-col gap-4">
          <h2 id="decision" className="text-lg font-semibold">
            Decision
          </h2>
          <Markdown>{outcome.finalText}</Markdown>
        </section>
      ) : null}

      {entry.rationale ? (
        <section aria-labelledby="rationale" className="flex flex-col gap-2">
          <h2 id="rationale" className="text-lg font-semibold">
            Rationale
          </h2>
          <Markdown>{entry.rationale}</Markdown>
        </section>
      ) : null}

      {isDecision && decision && outcome ? (
        <Card className="py-4">
          <CardContent className="px-4">
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <Fact label="Decider">{decision.deciderName}</Fact>
              <Fact label="Decided on">{fmt.date(outcome.decidedOn)}</Fact>
              <Fact label="How it was decided">{HOW_DECIDED_LABELS[decision.howDecided]}</Fact>
              <Fact label="Reversibility">
                {decision.reversibility ? REVERSIBILITY_LABELS[decision.reversibility] : NOT_SET}
                {decision.reversibility === "one_way" && decision.reversibilityReason ? `: ${decision.reversibilityReason}` : null}
              </Fact>
              {decision.effectiveDate ? <Fact label="Effective date">{fmt.date(decision.effectiveDate)}</Fact> : null}
              {decision.reviewDate ? <Fact label="Review date">{fmt.date(decision.reviewDate)}</Fact> : null}
              {entry.involved.length > 0 ? <Fact label="Involved people">{entry.involved.map((p) => p.name).join(", ")}</Fact> : null}
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <EntryFacts entry={entry} mayChangeImpact={mayChangeImpact} />

      {isDecision ? <Addenda entry={entry} mayAddAddendum={mayAddAddendum} /> : null}
    </article>
  );
}
