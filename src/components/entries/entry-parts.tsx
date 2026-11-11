import Link from "next/link";
import { addAddendumAction, changeImpactAction } from "@/app/(app)/entry-actions";
import { Disclosure } from "@/components/disclosure";
import { AddendumForm } from "@/components/entries/addendum-form";
import { ActionForm } from "@/components/form/action-form";
import { Markdown } from "@/components/markdown";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemContent, ItemHeader } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { IMPACT_HELP, IMPACT_LABELS, IMPACTS, NOT_SET, REVERSIBILITY_LABELS, TYPE_LABELS, type EntryType, type Impact, type Reversibility } from "@/lib/entries/constants";
import type { EntryDetail } from "@/lib/entries/queries";
import { entryPath, formatEntryRef } from "@/lib/entries/refs";
import { getFormatter } from "@/lib/auth/session";

/*
 * Parts every entry page shows: badges, the facts
 * of an entry, its impact, and the addenda of a decision.
 */

/** "Must read" for Large entries; otherwise the impact, if set. */
export function ImpactBadge({ impact }: { impact: Impact | null }) {
  if (impact === "large") return <Badge variant="destructive">Must read</Badge>;
  if (!impact) return null;
  return <Badge variant="outline">{`${IMPACT_LABELS[impact]} impact`}</Badge>;
}

export function EntryBadges({
  type,
  impact,
  reversibility,
  status,
  superseded,
}: {
  type: EntryType;
  impact: Impact | null;
  reversibility?: Reversibility | null;
  /** The phase or outcome of a proposal. */
  status?: string;
  superseded?: boolean;
}) {
  return (
    <>
      <Badge variant={type === "decision" ? "default" : "secondary"}>{TYPE_LABELS[type]}</Badge>
      <ImpactBadge impact={impact} />
      {reversibility ? <Badge variant="outline">{REVERSIBILITY_LABELS[reversibility]}</Badge> : null}
      {status ? <Badge variant="secondary">{status}</Badge> : null}
      {superseded ? <Badge variant="outline">Replaced</Badge> : null}
    </>
  );
}

export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** "This decision was replaced" and "Replaces LB-…". */
export function SupersedeNotes({ entry }: { entry: EntryDetail }) {
  return (
    <>
      {entry.supersededBy ? (
        <Alert>
          <AlertTitle>This decision was replaced</AlertTitle>
          <AlertDescription>
            <Link className="underline" href={entryPath(entry.supersededBy.number)}>
              {formatEntryRef(entry.supersededBy.number)}: {entry.supersededBy.title}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      {entry.supersedes ? (
        <p className="text-sm">
          Replaces{" "}
          <Link className="underline" href={entryPath(entry.supersedes.number)}>
            {formatEntryRef(entry.supersedes.number)}: {entry.supersedes.title}
          </Link>
        </p>
      ) : null}
    </>
  );
}

/** Impact, affected teams, tags, links, and related entries. */
export function EntryFacts({ entry, mayChangeImpact }: { entry: EntryDetail; mayChangeImpact: boolean }) {
  return (
    <section aria-labelledby="facts" className="flex flex-col gap-4">
      <h2 id="facts" className="sr-only">
        Details
      </h2>
      <Card className="py-4">
        <CardContent className="px-4">
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <Fact label="Impact">
              {entry.impact ? `${IMPACT_LABELS[entry.impact]}: ${IMPACT_HELP[entry.impact]}` : NOT_SET}
              {mayChangeImpact ? <ImpactControl entry={entry} /> : null}
            </Fact>
            <Fact label="Team">{entry.teamName}</Fact>
            {entry.affectedTeams.length > 0 ? <Fact label="Affected teams">{entry.affectedTeams.map((t) => t.name).join(", ")}</Fact> : null}
            {entry.tags.length > 0 ? (
              <Fact label="Tags">
                <span className="flex flex-wrap gap-1">
                  {entry.tags.map((tag) => (
                    <Badge key={tag.id} variant="outline">
                      {tag.name}
                    </Badge>
                  ))}
                </span>
              </Fact>
            ) : null}
            {entry.links.length > 0 ? (
              <Fact label="Links">
                <ul className="flex flex-col gap-1">
                  {entry.links.map((link) => (
                    <li key={link.url}>
                      <a className="break-all underline" href={link.url} target="_blank" rel="noopener noreferrer nofollow">
                        {link.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </Fact>
            ) : null}
            {entry.related.length > 0 ? (
              <Fact label="Related entries">
                <ul className="flex flex-col gap-1">
                  {entry.related.map((related) => (
                    <li key={related.id}>
                      <Link className="underline" href={entryPath(related.number)}>
                        {formatEntryRef(related.number)}: {related.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Fact>
            ) : null}
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}

/** Impact classifies an entry, so its author, decider, or an admin may change it later. */
function ImpactControl({ entry }: { entry: EntryDetail }) {
  return (
    <Disclosure title="Change impact" className="mt-2">
      <ActionForm action={changeImpactAction.bind(null, entry.id, entry.number)} submitLabel="Save impact" variant="outline">
        <Label htmlFor="new-impact">Impact</Label>
        <NativeSelect id="new-impact" name="impact" defaultValue={entry.impact ?? ""} required wrapperClassName="w-full" className="w-full">
          <NativeSelectOption value="" disabled>
            Choose…
          </NativeSelectOption>
          {IMPACTS.map((impact) => (
            <NativeSelectOption key={impact} value={impact}>
              {IMPACT_LABELS[impact]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </ActionForm>
    </Disclosure>
  );
}

/** Corrections and additions to a published decision. */
export async function Addenda({ entry, mayAddAddendum }: { entry: EntryDetail; mayAddAddendum: boolean }) {
  const fmt = await getFormatter();
  return (
    <section id="addenda" aria-labelledby="addenda-heading" className="flex flex-col gap-4 border-t pt-6">
      <h2 id="addenda-heading" className="text-lg font-semibold">
        Addenda
      </h2>
      {entry.addenda.length === 0 ? <p className="text-sm text-muted-foreground">No addenda.</p> : null}
      <ol className="flex flex-col gap-3">
        {entry.addenda.map((addendum) => (
          <Item key={addendum.id} asChild variant="outline" className="flex-col items-stretch gap-2">
            <li>
              <ItemHeader className="text-xs text-muted-foreground">
                {addendum.authorName} · {fmt.dateTime(addendum.createdAt)}
              </ItemHeader>
              <ItemContent>
                <Markdown>{addendum.text}</Markdown>
              </ItemContent>
            </li>
          </Item>
        ))}
      </ol>
      {mayAddAddendum ? <AddendumForm action={addAddendumAction.bind(null, entry.id, entry.number)} /> : null}
    </section>
  );
}
