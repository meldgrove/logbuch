import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getFormatter } from "@/lib/auth/session";
import type { Measures } from "@/lib/measures/summary";

const percent = (part: number, whole: number) => (whole === 0 ? "—" : `${Math.round((part / whole) * 100)} %`);

function MedianCell({ days, decisions }: { days: number | null; decisions: number }) {
  if (days === null) return <span className="text-muted-foreground">—</span>;
  return (
    <>
      {days} <span className="text-muted-foreground">({decisions === 1 ? "1 decision" : `${decisions} decisions`})</span>
    </>
  );
}

/** How Logbuch and the decision process are used, by month. */
export async function MonthlyStatistics({ measures }: { measures: Measures }) {
  const fmt = await getFormatter();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>By month</h2>
        </CardTitle>
        <CardDescription>
          Proposals started and finished, how long decisions take, entries logged, and how many people opened
          Logbuch.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm">
          Since the start: {measures.total.started} {measures.total.started === 1 ? "proposal" : "proposals"} submitted,{" "}
          {measures.total.finished} finished ({percent(measures.total.finished, measures.total.started)}).
        </p>
        <Table scrollLabel="Statistics by month">
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              <TableHead className="h-auto py-2 text-right whitespace-normal">Proposals started</TableHead>
              <TableHead className="h-auto py-2 text-right whitespace-normal">Finished of these</TableHead>
              <TableHead className="h-auto py-2 text-right whitespace-normal">Days to decision, two-way</TableHead>
              <TableHead className="h-auto py-2 text-right whitespace-normal">Days to decision, one-way</TableHead>
              <TableHead className="text-right">Updates</TableHead>
              <TableHead className="text-right">Learnings</TableHead>
              <TableHead className="h-auto py-2 text-right whitespace-normal">Decisions logged</TableHead>
              <TableHead className="h-auto py-2 text-right whitespace-normal">Active people</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {measures.months.map((m) => (
              <TableRow key={m.month}>
                <TableCell>
                  {fmt.month(m.month)}
                  {m.activeFrom ? (
                    <span className="block text-xs text-muted-foreground">activity from {fmt.date(m.activeFrom)}</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">{m.started}</TableCell>
                <TableCell className="text-right">
                  {m.started === 0 ? "—" : `${m.startedFinished} (${percent(m.startedFinished, m.started)})`}
                </TableCell>
                <TableCell className="text-right">
                  <MedianCell days={m.medianWorkingDays.two_way} decisions={m.decisions.two_way} />
                </TableCell>
                <TableCell className="text-right">
                  <MedianCell days={m.medianWorkingDays.one_way} decisions={m.decisions.one_way} />
                </TableCell>
                <TableCell className="text-right">{m.published.updates}</TableCell>
                <TableCell className="text-right">{m.published.learnings}</TableCell>
                <TableCell className="text-right">{m.published.decisions}</TableCell>
                <TableCell className="text-right">
                  {m.activePeople === null ? (
                    <span className="text-muted-foreground">Not recorded</span>
                  ) : (
                    `${m.activePeople} (${percent(m.activePeople, measures.peopleWithAccess)})`
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">
          Months in the server&apos;s time zone. Days to decision: the median number of working days from submission to the
          decision, for decisions made that month. Active people opened Logbuch at least once
          that month; the share is of the {measures.peopleWithAccess} people with access today. Activity is recorded
          from the release that added it on.
        </p>
      </CardContent>
    </Card>
  );
}
