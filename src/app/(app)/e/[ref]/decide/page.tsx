import { Check, X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { publishAction, rejectAction } from "@/app/(app)/proposal-actions";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { MarkdownField } from "@/components/form/markdown-field";
import { PersonalDataField } from "@/components/form/personal-data-field";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Item, ItemHeader } from "@/components/ui/item";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { SUMMARY_MAX } from "@/lib/entries/constants";
import { clipText } from "@/lib/format";
import { loadEntry } from "@/lib/entries/page-helpers";
import { entryPath, formatEntryRef } from "@/lib/entries/refs";
import { getProposalView } from "@/lib/process/queries";

export const metadata: Metadata = { title: "Decide" };

/** The decider's view: criteria, open objections, publish or reject. */
export default async function DecidePage({ params }: PageProps<"/e/[ref]/decide">) {
  const { person } = await requireUser();
  const entry = await loadEntry((await params).ref, person.id);
  if (!entry.isProposal) notFound();
  const view = await getProposalView(getDb(), entry.id, { personId: person.id, isAdmin: person.isAdmin });
  if (!view || view.decider.id !== person.id) notFound();
  if (view.status !== "feedback" && view.status !== "objection_round") redirect(entryPath(entry.number));
  const current = view.versions.at(-1);
  const openObjections = view.objections.filter((o) => o.open);

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <PageHeader
        title="Decide"
        eyebrow={
          <Link className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground" href={entryPath(entry.number)}>
            {formatEntryRef(entry.number)}: {entry.title}
          </Link>
        }
      />

      <section aria-labelledby="criteria" className="flex flex-col gap-3">
        <h2 id="criteria" className="text-lg font-semibold">
          Criteria
        </h2>
        <ul className="flex flex-col gap-2 text-sm">
          {view.readiness.criteria.map((criterion) => (
            <li key={criterion.key} className="flex items-start gap-2">
              {criterion.ok ? (
                <Check className="mt-0.5 size-4 text-green-700 dark:text-green-400" aria-hidden="true" />
              ) : (
                <X className="mt-0.5 size-4 text-destructive" aria-hidden="true" />
              )}
              <span>
                <span className="sr-only">{criterion.ok ? "Met: " : "Not met: "}</span>
                {criterion.label}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="open-objections" className="flex flex-col gap-3">
        <h2 id="open-objections" className="text-lg font-semibold">
          Open objections
        </h2>
        {openObjections.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : null}
        <ul className="flex flex-col gap-2">
          {openObjections.map((objection) => (
            <Item key={objection.id} asChild variant="outline" size="sm" className="flex-col items-stretch gap-1">
              <li>
                <ItemHeader className="text-xs text-muted-foreground">
                  {objection.personName}
                  {objection.blocking ? " · blocking" : ""}
                </ItemHeader>
                <p className="whitespace-pre-wrap">{objection.text}</p>
              </li>
            </Item>
          ))}
        </ul>
      </section>

      <Card role="region" aria-labelledby="publish">
        <CardHeader>
          <CardTitle>
            <h2 id="publish">Publish the decision</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {view.permissions.publish ? (
            <ActionForm action={publishAction.bind(null, entry.id, entry.number)} submitLabel="Publish decision" pendingLabel="Publishing…" className="gap-5">
              <Field id="summary" label="Summary" required hint="Shown in the timeline and the Slack post. Describe the decision, not the question.">
                <Input id="summary" name="summary" required maxLength={SUMMARY_MAX} defaultValue={clipText(entry.summary, SUMMARY_MAX)} aria-describedby="summary-hint" />
              </Field>
              <Field id="finalText" label="Decision text" required>
                <MarkdownField id="finalText" name="finalText" required rows={6} defaultValue={current?.text} />
              </Field>
              <Field id="rationale" label="Rationale" required>
                <MarkdownField id="rationale" name="rationale" required rows={4} />
              </Field>
              {view.objectionHandlingRequired ? (
                <Field id="objectionHandling" label="How objections were addressed" required>
                  <MarkdownField id="objectionHandling" name="objectionHandling" required rows={4} />
                </Field>
              ) : null}
              <Field id="effectiveDate" label="Effective date">
                <Input id="effectiveDate" name="effectiveDate" type="date" className="max-w-xs" />
              </Field>
              <PersonalDataField />
            </ActionForm>
          ) : (
            <p className="text-sm text-muted-foreground">Not all criteria are met yet.</p>
          )}
        </CardContent>
      </Card>

      <Card role="region" aria-labelledby="reject">
        <CardHeader>
          <CardTitle>
            <h2 id="reject">Reject the proposal</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={rejectAction.bind(null, entry.id, entry.number)} submitLabel="Reject" variant="destructive" pendingLabel="Rejecting…" className="gap-5">
            <Field id="reject-rationale" label="Rationale" required>
              <MarkdownField id="reject-rationale" name="rationale" required rows={4} />
            </Field>
            <PersonalDataField />
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
