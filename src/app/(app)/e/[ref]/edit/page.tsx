import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { editNoteAction } from "@/app/(app)/entry-actions";
import { saveDraftAction } from "@/app/(app)/proposal-actions";
import { LogForm } from "@/components/entries/log-form";
import { PageHeader } from "@/components/page-header";
import { ProposalForm } from "@/components/proposals/proposal-form";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { loadEntry } from "@/lib/entries/page-helpers";
import { getFormOptions, getNoteFormValues } from "@/lib/entries/queries";
import { formatEntryRef } from "@/lib/entries/refs";
import { DEADLINE_END, serverDate } from "@/lib/format";
import { getDraftFormValues, periodDefaults } from "@/lib/process/form-defaults";

export const metadata: Metadata = { title: "Edit" };

/**
 * The proposer edits a private draft; the author edits a published update or
 * learning, and every save becomes a new revision. Decisions are not edited.
 */
export default async function EditEntryPage({ params }: PageProps<"/e/[ref]/edit">) {
  const { person } = await requireUser();
  const entry = await loadEntry((await params).ref, person.id);
  const db = getDb();
  if (entry.isProposal && entry.status === "draft" && entry.authorId === person.id) {
    const [options, periods, values] = await Promise.all([getFormOptions(db), periodDefaults(db), getDraftFormValues(db, entry.id)]);
    if (!values) notFound();
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <PageHeader title={`Edit draft ${formatEntryRef(entry.number)}`} />
        <ProposalForm action={saveDraftAction.bind(null, entry.id)} options={options} periodDefaults={periods} proposerId={person.id} defaults={values} dateFormat={(await getFormatter()).dateFormat} deadlineEnd={DEADLINE_END} />
      </div>
    );
  }
  if (entry.type === "decision" || entry.status !== "published" || entry.authorId !== person.id) notFound();
  const [options, values] = await Promise.all([getFormOptions(db), getNoteFormValues(db, entry.id)]);
  if (!values) notFound();
  // A team or tag deactivated after publishing stays selectable for this entry.
  const teams = options.teams.some((t) => t.id === values.teamId)
    ? options.teams
    : [...options.teams, { id: values.teamId, label: entry.teamName }];
  const tags = [...options.tags, ...entry.tags.filter((t) => !options.tags.some((o) => o.id === t.id)).map((t) => ({ id: t.id, label: t.name }))];

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title={`Edit ${formatEntryRef(entry.number)}`} description="Every saved change is kept as a new version and shown in the history." />
      <LogForm
        action={editNoteAction.bind(null, entry.id, entry.number)}
        options={{ ...options, teams, tags }}
        types={["update", "learning"]}
        today={serverDate()}
        entryId={entry.id}
        defaults={{
          ...values,
          related: values.related.map((r) => ({ id: r.id, label: `${formatEntryRef(r.number)}: ${r.title}` })),
        }}
        submitLabel="Save changes"
      />
    </div>
  );
}
