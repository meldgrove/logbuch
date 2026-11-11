import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DiffView } from "@/components/entries/diff-view";
import { PageHeader } from "@/components/page-header";
import { Item, ItemTitle } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { IMPACT_LABELS, NOT_SET, REVERSIBILITY_LABELS, TYPE_LABELS, type Impact } from "@/lib/entries/constants";
import { hasChanges, textDiff } from "@/lib/entries/diff";
import { loadEntry } from "@/lib/entries/page-helpers";
import { getEntryHistory } from "@/lib/entries/queries";
import { getProposalVersions } from "@/lib/process/queries";
import { entryPath, formatEntryRef } from "@/lib/entries/refs";

export const metadata: Metadata = { title: "History" };

const ACTION_LABELS: Record<string, string> = {
  "entry.published": "Published",
  "entry.edited": "Edited",
  "entry.superseded": "Replaced by a newer decision",
  "entry.addendum_added": "Addendum added",
  "entry.impact_changed": "Impact changed",
  "proposal.submitted": "Submitted, feedback started",
  "proposal.version_added": "New version",
  "proposal.question_asked": "Question asked",
  "proposal.question_answered": "Question answered",
  "proposal.feedback_given": "Feedback given",
  "proposal.go_given": "Go given",
  "proposal.go_withdrawn": "Go withdrawn",
  "proposal.objection_raised": "Objection raised",
  "proposal.objection_resolved": "Objection resolved",
  "proposal.objection_round_started": "Objection round started",
  "proposal.deadline_extended": "Deadline extended",
  "proposal.type_changed": "Two-way or one-way changed",
  "proposal.participant_added": "Person added",
  "proposal.participant_removed": "Person removed",
  "proposal.decider_changed": "Decider changed",
  "proposal.decided": "Decision published",
  "proposal.rejected": "Rejected",
  "proposal.withdrawn": "Withdrawn",
};

const impactLabel = (value: unknown) => (typeof value === "string" && value in IMPACT_LABELS ? IMPACT_LABELS[value as Impact] : NOT_SET);
const reversibilityLabel = (value: unknown) =>
  value === "two_way" || value === "one_way" ? REVERSIBILITY_LABELS[value] : String(value);

/** Extra detail for audit events, from their payload. */
function eventDetail(action: string, payload: Record<string, unknown>): string {
  if (action === "entry.impact_changed") return ` (${impactLabel(payload.from)} → ${impactLabel(payload.to)})`;
  if (action === "entry.edited" && typeof payload.revision === "number") return ` (version ${payload.revision})`;
  if (action === "proposal.version_added" && typeof payload.version === "number") return ` (version ${payload.version})`;
  if (action === "proposal.deadline_extended") return ` (${String(payload.phase)}: ${String(payload.from)} → ${String(payload.to)})`;
  if (action === "proposal.type_changed") return ` (${reversibilityLabel(payload.from)} → ${reversibilityLabel(payload.to)}: ${String(payload.reason)})`;
  if (typeof payload.reason === "string" && payload.reason) return ` (${payload.reason})`;
  return "";
}

export default async function EntryHistoryPage({ params }: PageProps<"/e/[ref]/history">) {
  const { person } = await requireUser();
  const fmt = await getFormatter();
  const entry = await loadEntry((await params).ref, person.id);
  if (entry.status === "draft") notFound();
  const [history, proposalVersions] = await Promise.all([getEntryHistory(getDb(), entry.id), getProposalVersions(getDb(), entry.id)]);
  const versions = history.revisions.map((revision, index) => {
    const previous = history.revisions[index - 1];
    if (!previous) return { revision, changes: [] };
    const field = (label: string, before: string, after: string) => ({ label, parts: textDiff(before, after) });
    const changes = [
      field("Type", TYPE_LABELS[previous.type], TYPE_LABELS[revision.type]),
      field("Title", previous.title, revision.title),
      field("Impact", impactLabel(previous.impact), impactLabel(revision.impact)),
      field("Team", previous.teamName, revision.teamName),
      field("Affected teams", previous.affectedTeamNames.join(", "), revision.affectedTeamNames.join(", ")),
      field("Tags", previous.tagNames.join(", "), revision.tagNames.join(", ")),
      field("Summary", previous.summary, revision.summary),
      field("Details", previous.body, revision.body),
      field("Rationale", previous.rationale, revision.rationale),
      field("Links", previous.links.map((l) => l.url).join("\n"), revision.links.map((l) => l.url).join("\n")),
      field(
        "Related entries",
        previous.relatedNumbers.map(formatEntryRef).join(", "),
        revision.relatedNumbers.map(formatEntryRef).join(", "),
      ),
    ].filter((change) => hasChanges(change.parts));
    return { revision, changes };
  });

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <PageHeader
        title={`History of ${formatEntryRef(entry.number)}`}
        description={
          <Link className="underline underline-offset-4 hover:text-foreground" href={entryPath(entry.number)}>
            {entry.title}
          </Link>
        }
      />

      {proposalVersions.length > 0 ? (
        <section aria-labelledby="proposal-versions" className="flex flex-col gap-4">
          <h2 id="proposal-versions" className="text-lg font-semibold">
            Proposal versions
          </h2>
          <ol className="flex flex-col gap-4">
            {[...proposalVersions].reverse().map((version, index, reversed) => {
              const previous = reversed[index + 1];
              return (
                <Item key={version.id} asChild variant="outline" className="flex-col items-stretch gap-2">
                  <li>
                    <ItemTitle>
                      Version {version.number} · {version.authorName} · {fmt.dateTime(version.createdAt)}
                    </ItemTitle>
                    {version.changeNote ? <p>{version.changeNote}</p> : null}
                    {previous ? <DiffView parts={textDiff(previous.text, version.text)} /> : <p className="text-muted-foreground">First version.</p>}
                  </li>
                </Item>
              );
            })}
          </ol>
        </section>
      ) : null}

      {versions.length > 0 ? (
        <section aria-labelledby="versions" className="flex flex-col gap-4">
          <h2 id="versions" className="text-lg font-semibold">
            Versions
          </h2>
          <ol className="flex flex-col gap-4">
            {[...versions].reverse().map(({ revision, changes }) => (
              <Item key={revision.id} asChild variant="outline" className="flex-col items-stretch gap-3">
                <li>
                  <ItemTitle>
                    Version {revision.revision} · {revision.editorName} · {fmt.dateTime(revision.createdAt)}
                  </ItemTitle>
                  {revision.revision === 1 ? (
                    <p className="text-muted-foreground">Original version.</p>
                  ) : (
                    changes.map((change) => (
                      <div key={change.label} className="flex flex-col gap-1">
                        <h3 className="text-xs font-semibold text-muted-foreground uppercase">{change.label}</h3>
                        <DiffView parts={change.parts} />
                      </div>
                    ))
                  )}
                </li>
              </Item>
            ))}
          </ol>
        </section>
      ) : null}

      <section aria-labelledby="audit" className="flex flex-col gap-4">
        <h2 id="audit" className="text-lg font-semibold">
          Audit log
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>What</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.events.map((event) => (
              <TableRow key={event.id}>
                <TableCell>{fmt.dateTime(event.createdAt)}</TableCell>
                <TableCell>{event.actorName ?? "Logbuch"}</TableCell>
                <TableCell>
                  {ACTION_LABELS[event.action] ?? event.action}
                  {eventDetail(event.action, event.payload)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
