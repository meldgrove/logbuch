import Link from "next/link";
import { EntryBadges } from "@/components/entries/entry-parts";
import { PROPOSAL_BADGES } from "@/components/proposals/labels";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { TimelineItem } from "@/lib/entries/queries";
import { entryPath, formatEntryRef } from "@/lib/entries/refs";
import { getFormatter } from "@/lib/auth/session";
import type { ProposalStatus } from "@/lib/process/rules";
import { cn } from "@/lib/utils";

/** One entry in the timeline. The whole card links to the entry. */
export async function EntryCard({ item }: { item: TimelineItem }) {
  const fmt = await getFormatter();
  const proposalStatus = item.isProposal ? PROPOSAL_BADGES[item.status as ProposalStatus] : undefined;
  return (
    <Card
      role="article"
      aria-labelledby={`entry-${item.number}`}
      className={cn(
        "relative gap-3 py-4 transition-colors hover:bg-muted/30 has-[a:focus-visible]:ring-[3px] has-[a:focus-visible]:ring-ring/50",
        item.pinned && "border-destructive/50",
      )}
    >
      <CardHeader className="gap-2 px-4">
        <div className="flex flex-wrap items-center gap-2">
          <EntryBadges
            type={item.type}
            impact={item.impact}
            reversibility={item.reversibility}
            status={proposalStatus}
            superseded={Boolean(item.supersededById)}
          />
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{formatEntryRef(item.number)}</span>
        </div>
        <CardTitle>
          <h2 id={`entry-${item.number}`} className="text-base leading-snug">
            <Link href={entryPath(item.number)} className="after:absolute after:inset-0 hover:underline focus-visible:outline-none">
              {item.title}
            </Link>
          </h2>
        </CardTitle>
        <CardDescription className="text-foreground">{item.summary}</CardDescription>
      </CardHeader>
      <CardFooter className="flex-col items-start gap-2 px-4">
        <p className="text-xs text-muted-foreground">
          {item.teamName} · {item.authorName} · {fmt.published(item.publishedAt, item.imported)}
          {item.editedAt ? " · edited" : null}
          {item.type === "decision" && !item.isProposal && item.decidedOn ? ` · decided on ${fmt.date(item.decidedOn)} by ${item.deciderName}` : null}
          {item.isProposal && item.decidedOn ? ` · ${item.status} on ${fmt.date(item.decidedOn)}` : null}
          {item.status === "feedback" && item.feedbackDeadline ? ` · feedback until ${fmt.date(item.feedbackDeadline)}` : null}
          {item.status === "objection_round" && item.objectionDeadline ? ` · objections until ${fmt.date(item.objectionDeadline)}` : null}
          {item.affectedTeams.length > 0 ? ` · affects ${item.affectedTeams.join(", ")}` : null}
        </p>
        {item.tags.length > 0 ? (
          <ul className="flex flex-wrap gap-1" aria-label="Tags">
            {item.tags.map((name) => (
              <li key={name}>
                <Badge variant="outline" className="font-normal">
                  {name}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </CardFooter>
    </Card>
  );
}
