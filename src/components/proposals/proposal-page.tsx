import { Check, ChevronDown, CircleAlert, Gavel, History, Pencil } from "lucide-react";
import Link from "next/link";
import {
  addParticipantAction,
  addVersionAction,
  answerAction,
  changeDeciderAction,
  changeReversibilityAction,
  discardDraftAction,
  extendDeadlineAction,
  goAction,
  postResponseAction,
  removeParticipantAction,
  replaceConsentGiverAction,
  resolveObjectionAction,
  startObjectionRoundAction,
  submitProposalAction,
  withdrawAction,
  withdrawGoAction,
} from "@/app/(app)/proposal-actions";
import { Disclosure } from "@/components/disclosure";
import { Addenda, EntryBadges, EntryFacts, SupersedeNotes } from "@/components/entries/entry-parts";
import { DiffView } from "@/components/entries/diff-view";
import { ActionForm } from "@/components/form/action-form";
import { MarkdownField } from "@/components/form/markdown-field";
import { OptionPicker, type PickerOption } from "@/components/form/option-picker";
import { PersonalDataField, PersonalDataNotice } from "@/components/form/personal-data-field";
import { Markdown } from "@/components/markdown";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { REVERSIBILITY_LABELS, SUMMARY_MAX } from "@/lib/entries/constants";
import { textDiff } from "@/lib/entries/diff";
import type { EntryDetail } from "@/lib/entries/queries";
import { entryPath, formatEntryRef } from "@/lib/entries/refs";
import { getFormatter } from "@/lib/auth/session";
import { clipText, DEADLINE_END } from "@/lib/format";
import type { ProposalView } from "@/lib/process/queries";
import { MINIMUM_PERIODS, mayGiveConsent, type ParticipantState } from "@/lib/process/rules";
import { cn } from "@/lib/utils";
import { AddPersonFields } from "./add-person-fields";
import { PROPOSAL_BADGES, STATUS_LABELS } from "./labels";

const STATE_LABELS: Record<ParticipantState, string> = {
  waiting: "Waiting",
  feedback_given: "Feedback given",
  go: "Go",
  go_older_version: "Go on an older version, asked to confirm again",
  objection: "Objection",
  no_access: "No access, must be replaced",
};

const FIELD_LABELS: Record<string, string> = {
  body: "Context",
  impact: "Impact",
  proposalText: "Proposal",
  deciderId: "Decider",
  reversibilityReason: "Why one-way",
  consentGiverIds: "Consent givers",
  feedbackDeadline: "Feedback deadline",
  objectionPeriodDays: "Objection period",
  supersedesId: "Supersedes",
};

interface ProposalPageProps {
  entry: EntryDetail;
  view: ProposalView;
  people: PickerOption[];
  viewerId: string;
  mayAddAddendum: boolean;
  mayChangeImpact: boolean;
}

export async function ProposalPage({ entry, view, people, viewerId, mayAddAddendum, mayChangeImpact }: ProposalPageProps) {
  const fmt = await getFormatter();
  const ref = formatEntryRef(entry.number);
  const bind = <A extends unknown[], R>(action: (entryId: string, number: number, ...rest: A) => R) =>
    action.bind(null, entry.id, entry.number) as (...rest: A) => R;
  const current = view.versions.at(-1);
  const previous = view.versions.at(-2);
  const p = view.permissions;
  const open = view.status === "feedback" || view.status === "objection_round";

  return (
    <article className="flex max-w-3xl flex-col gap-8">
      <PageHeader
        title={entry.title}
        eyebrow={
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <EntryBadges
              type="decision"
              impact={entry.impact}
              reversibility={view.reversibility}
              status={PROPOSAL_BADGES[view.status]}
              superseded={Boolean(entry.supersededBy)}
            />
            <span className="text-xs text-muted-foreground tabular-nums">{ref}</span>
          </div>
        }
        description={
          <>
            {entry.teamName} · proposed by {view.proposer.name}
            {entry.submittedAt ? ` · ${fmt.dateTime(entry.submittedAt)}` : " · private draft"}
          </>
        }
        actions={
          <>
            {view.decider.id === viewerId && open ? (
              <Button asChild size="sm">
                <Link href={`${entryPath(entry.number)}/decide`}>
                  <Gavel aria-hidden="true" />
                  Decide
                </Link>
              </Button>
            ) : null}
            {view.status !== "draft" ? (
              <Button asChild size="sm" variant="ghost">
                <Link href={`${entryPath(entry.number)}/history`}>
                  <History aria-hidden="true" />
                  History
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <PhaseStepper view={view} />

      <SupersedeNotes entry={entry} />

      {view.status === "draft" ? <DraftPanel entry={entry} view={view} bind={bind} /> : null}

      {entry.summary !== clipText(view.question, SUMMARY_MAX) ? <p className="text-base">{entry.summary}</p> : null}

      {entry.outcome ? (
        <Card role="region" aria-labelledby="outcome">
          <CardHeader>
            <CardTitle>
              <h2 id="outcome" className="text-lg">
                {STATUS_LABELS[view.status]} on {fmt.date(entry.outcome.decidedOn)} by {entry.outcome.decidedByName}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {entry.outcome.finalText ? <Markdown>{entry.outcome.finalText}</Markdown> : null}
            {entry.rationale ? (
              <>
                <h3 className="font-semibold">{view.status === "withdrawn" ? "Reason" : "Rationale"}</h3>
                <Markdown>{entry.rationale}</Markdown>
              </>
            ) : null}
            {entry.outcome.objectionHandling ? (
              <>
                <h3 className="font-semibold">How objections were addressed</h3>
                <Markdown>{entry.outcome.objectionHandling}</Markdown>
              </>
            ) : null}
            {view.effectiveDate ? <p className="text-sm">Effective {fmt.date(view.effectiveDate)}</p> : null}
            {view.reviewDate && view.status === "decided" ? <p className="text-sm">Review on {fmt.date(view.reviewDate)}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      <section aria-labelledby="question" className="flex flex-col gap-3">
        <h2 id="question" className="text-lg font-semibold">
          Question
        </h2>
        <p>{view.question}</p>
        {entry.body ? (
          <>
            <h3 className="font-semibold">Context</h3>
            <Markdown>{entry.body}</Markdown>
          </>
        ) : null}
      </section>

      <section aria-labelledby="proposal" className="flex flex-col gap-3">
        <h2 id="proposal" className="text-lg font-semibold">
          Proposal{view.versions.length > 1 ? `, version ${view.currentVersion}` : ""}
        </h2>
        {current?.text ? <Markdown>{current.text}</Markdown> : <p className="text-sm text-muted-foreground">No proposal text yet.</p>}
        {current && previous ? (
          <Disclosure title={`Changes from version ${previous.number}${current.changeNote ? `: ${current.changeNote}` : ""}`}>
            <DiffView parts={textDiff(previous.text, current.text)} />
          </Disclosure>
        ) : null}
        {view.reversibility === "one_way" && view.reversibilityReason ? (
          <p className="text-sm">
            <span className="font-medium">Why one-way:</span> {view.reversibilityReason}
          </p>
        ) : null}
        {p.newVersion && current ? (
          <Disclosure title="Add a new version">
            <ActionForm action={bind(addVersionAction)} submitLabel="Save new version">
              <MarkdownField id="new-version" name="proposalText" required defaultValue={current.text} rows={8} />
              <Label htmlFor="change-note">Change note</Label>
              <Input id="change-note" name="changeNote" placeholder="What changed and why" />
              {view.reversibility === "one_way" ? (
                <p className="text-sm text-muted-foreground">Every consent giver is asked to give their Go again.</p>
              ) : null}
              <PersonalDataField />
            </ActionForm>
          </Disclosure>
        ) : null}
      </section>

      <PeopleSection view={view} people={people} bind={bind} />

      <EntryFacts entry={entry} mayChangeImpact={mayChangeImpact} />

      {open ? <NextSteps view={view} people={people} bind={bind} /> : null}

      {view.status !== "draft" ? <Threads view={view} bind={bind} /> : null}

      {open && (p.withdraw || p.reject) ? (
        <section aria-labelledby="close" className="flex flex-col gap-3 border-t pt-6">
          <h2 id="close" className="text-lg font-semibold">
            Close the proposal
          </h2>
          {p.reject ? (
            <p className="text-sm">
              As the decider, you can reject the proposal on the{" "}
              <Link className="underline" href={`${entryPath(entry.number)}/decide`}>
                Decide page
              </Link>
              .
            </p>
          ) : null}
          {p.withdraw ? (
            <Disclosure title="Withdraw the proposal">
              <ActionForm action={bind(withdrawAction)} submitLabel="Withdraw" variant="destructive">
                <Label htmlFor="withdraw-reason">Reason</Label>
                <Textarea id="withdraw-reason" name="reason" rows={2} />
                <PersonalDataField />
              </ActionForm>
            </Disclosure>
          ) : null}
        </section>
      ) : null}

      {view.status === "decided" ? <Addenda entry={entry} mayAddAddendum={mayAddAddendum} /> : null}
    </article>
  );
}

type Bind = <A extends unknown[], R>(action: (entryId: string, number: number, ...rest: A) => R) => (...rest: A) => R;

async function PhaseStepper({ view }: { view: ProposalView }) {
  const fmt = await getFormatter();
  const final = view.status === "decided" || view.status === "rejected" || view.status === "withdrawn";
  const steps = [
    { key: "draft", label: "Draft", detail: undefined },
    { key: "feedback", label: "Feedback", detail: `until ${fmt.date(view.feedbackDeadline)}` },
    {
      key: "objection_round",
      label: "Objection round",
      detail: view.objectionDeadline ? `until ${fmt.date(view.objectionDeadline)}` : `${view.objectionPeriodDays} working days`,
    },
    { key: "final", label: final ? STATUS_LABELS[view.status] : "Decided", detail: undefined },
  ];
  const position = { draft: 0, feedback: 1, objection_round: 2, decided: 3, rejected: 3, withdrawn: 3 }[view.status];
  return (
    <ol aria-label="Phases" className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
      {steps.map((step, index) => (
        <li
          key={step.key}
          aria-current={index === position ? "step" : undefined}
          className={cn(
            "flex items-start gap-2 rounded-lg border p-2.5",
            index === position ? "border-primary bg-primary/5" : index < position ? "bg-muted/40" : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums",
              index <= position && "border-primary bg-primary text-primary-foreground",
            )}
            aria-hidden="true"
          >
            {index < position ? <Check className="size-3" /> : index + 1}
          </span>
          <span className="flex flex-col">
            <span className="font-medium">{step.label}</span>
            {step.detail ? <span className="text-xs">{step.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function DraftPanel({ entry, view, bind }: { entry: EntryDetail; view: ProposalView; bind: Bind }) {
  const errors = Object.entries(view.submissionErrors);
  return (
    <Card role="region" aria-labelledby="draft" className="border-dashed">
      <CardHeader>
        <CardTitle>
          <h2 id="draft" className="text-lg">
            Private draft
          </h2>
        </CardTitle>
        <CardDescription>Only you can see this preview. Submitting starts the feedback phase and shows the proposal to everyone.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {errors.length > 0 ? (
          <Alert>
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Before you can submit:</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {errors.map(([field, message]) => (
                  <li key={field}>
                    {FIELD_LABELS[field] ?? field}: {message}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : (
          <ActionForm action={bind(submitProposalAction)} submitLabel="Submit proposal" pendingLabel="Submitting…">
            <PersonalDataField />
          </ActionForm>
        )}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href={`${entryPath(entry.number)}/edit`}>
            <Pencil aria-hidden="true" />
            Edit draft
          </Link>
        </Button>
        <ActionForm action={discardDraftAction.bind(null, entry.id)} submitLabel="Discard draft" pendingLabel="Discarding…" variant="ghost" />
      </CardFooter>
    </Card>
  );
}

function PeopleSection({ view, people, bind }: { view: ProposalView; people: PickerOption[]; bind: Bind }) {
  const p = view.permissions;
  // The pickers offer only the people the rules allow for each choice.
  const allowed = (ids: string[]) => people.filter((person) => ids.includes(person.id));
  const consent = view.participants.filter((x) => x.role === "consent_giver");
  const feedback = view.participants.filter((x) => x.role === "feedback_giver");

  const list = (title: string, rows: ProposalView["participants"]) => (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">Nobody.</p> : null}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const person = (
            <ItemContent className="flex-row flex-wrap items-center gap-2">
              <ItemTitle>{row.name}</ItemTitle>
              <Badge variant={row.state === "go" ? "default" : row.state === "no_access" || row.state === "objection" ? "destructive" : "secondary"}>
                {STATE_LABELS[row.state]}
              </Badge>
            </ItemContent>
          );
          const replaceable = p.adminOverride && row.role === "consent_giver";
          if (!row.removal.ok && !replaceable) {
            return (
              <Item key={`${row.role}-${row.personId}`} asChild variant="outline" size="sm">
                <li>{person}</li>
              </Item>
            );
          }
          return (
            <Collapsible key={`${row.role}-${row.personId}`} asChild>
              <Item asChild variant="outline" size="sm">
                <li>
                  {person}
                  <ItemActions>
                    <CollapsibleTrigger asChild>
                      <Button type="button" variant="ghost" size="xs" className="[&[data-state=open]>svg]:rotate-180">
                        {row.removal.ok ? "Remove" : "Replace"}
                        <ChevronDown className="transition-transform" aria-hidden="true" />
                      </Button>
                    </CollapsibleTrigger>
                  </ItemActions>
                  <CollapsibleContent className="flex basis-full flex-col gap-3 border-t pt-3">
                    {row.removal.ok ? (
                      <ActionForm action={bind(removeParticipantAction)} submitLabel={`Remove ${row.name}`} variant="outline">
                        <input type="hidden" name="personId" value={row.personId} />
                        <input type="hidden" name="role" value={row.role} />
                        <Input
                          name="reason"
                          aria-label={`Reason for removing ${row.name}`}
                          placeholder={row.removal.reasonRequired ? "Reason (required)" : "Reason"}
                          required={row.removal.reasonRequired}
                        />
                      </ActionForm>
                    ) : (
                      <p className="text-sm text-muted-foreground">{row.removal.reason}</p>
                    )}
                    {replaceable ? (
                      <ActionForm action={bind(replaceConsentGiverAction)} submitLabel={`Replace ${row.name}`} variant="outline">
                        <input type="hidden" name="personId" value={row.personId} />
                        <OptionPicker id={`replace-${row.personId}`} name="replacementId" options={allowed(row.replacements)} placeholder="New consent giver" />
                        <Input name="reason" aria-label="Reason for the replacement" placeholder="Reason (required)" required />
                      </ActionForm>
                    ) : null}
                  </CollapsibleContent>
                </li>
              </Item>
            </Collapsible>
          );
        })}
      </ul>
    </div>
  );

  return (
    <section aria-labelledby="people" className="flex flex-col gap-4">
      <h2 id="people" className="text-lg font-semibold">
        People
      </h2>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Proposer</dt>
          <dd>{view.proposer.name}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Decider</dt>
          <dd>
            {view.decider.name}
            {view.decider.hasAccess ? null : <Badge variant="destructive"> No access, must be replaced</Badge>}
          </dd>
        </div>
      </dl>
      {view.reversibility === "one_way" ? list("Consent givers", consent) : null}
      {list("Feedback from", feedback)}

      {p.manageParticipants ? (
        <Disclosure title="Add a person">
          <ActionForm action={bind(addParticipantAction)} submitLabel="Add" variant="outline">
            <AddPersonFields
              options={{
                feedback_giver: allowed(view.choices.feedbackGivers),
                ...(view.reversibility === "one_way" ? { consent_giver: allowed(view.choices.consentGivers) } : {}),
              }}
            />
          </ActionForm>
        </Disclosure>
      ) : null}
      {p.changeDecider ? (
        <Disclosure title="Change the decider">
          <ActionForm action={bind(changeDeciderAction)} submitLabel="Change decider" variant="outline">
            <Label htmlFor="new-decider">New decider</Label>
            <OptionPicker id="new-decider" name="deciderId" options={allowed(view.choices.deciders)} placeholder="Choose the decider" />
            <Label htmlFor="decider-reason">Reason{view.deciderChange.reasonRequired ? " (required)" : ""}</Label>
            <Input id="decider-reason" name="reason" required={view.deciderChange.reasonRequired} />
          </ActionForm>
        </Disclosure>
      ) : null}
    </section>
  );
}

async function NextSteps({ view, people, bind }: { view: ProposalView; people: PickerOption[]; bind: Bind }) {
  const fmt = await getFormatter();
  const p = view.permissions;
  const isProposer = p.withdraw;
  const changeTo = view.reversibility === "two_way" ? "one_way" : "two_way";
  return (
    <Card role="region" aria-labelledby="next">
      <CardHeader>
        <CardTitle>
          <h2 id="next" className="text-lg">
            {view.status === "feedback" ? "Feedback phase" : "Objection round"}
          </h2>
        </CardTitle>
        <CardDescription className="text-foreground">
          {view.status === "feedback"
            ? `Feedback until ${fmt.date(view.feedbackDeadline)}, ${DEADLINE_END}.`
            : `Objections until ${fmt.date(view.objectionDeadline)}, ${DEADLINE_END}.`}{" "}
          {view.reversibility === "two_way"
            ? "Objections are recorded and must be considered, but do not block."
            : "Every consent giver must give a Go on the current version."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isProposer && view.status === "feedback" ? (
          p.startObjectionRound.ok ? (
            <ActionForm action={bind(startObjectionRoundAction)} submitLabel="Start the objection round">
              <p className="text-sm text-muted-foreground">The objection deadline is set to {view.objectionPeriodDays} working days from today.</p>
            </ActionForm>
          ) : (
            <p className="text-sm text-muted-foreground">{p.startObjectionRound.reason}</p>
          )
        ) : null}

        {p.go ? (
          <ActionForm action={bind(goAction)} submitLabel={`Give my Go on version ${view.currentVersion}`}>
            <input type="hidden" name="version" value={view.currentVersion} />
            <Label htmlFor="go-comment">Comment</Label>
            <Textarea id="go-comment" name="text" rows={2} />
          </ActionForm>
        ) : null}
        {p.withdrawGo ? <ActionForm action={bind(withdrawGoAction)} submitLabel="Withdraw my Go" variant="outline" /> : null}

        {p.extendFeedbackDeadline || p.extendObjectionDeadline ? (
          <Disclosure title="Extend the deadline">
            <ActionForm action={bind(extendDeadlineAction)} submitLabel="Extend" variant="outline">
              <input type="hidden" name="phase" value={p.extendFeedbackDeadline ? "feedback" : "objection"} />
              <Label htmlFor="new-deadline">New deadline</Label>
              <Input id="new-deadline" name="deadline" type="date" required min={(p.extendFeedbackDeadline ? view.feedbackDeadline : view.objectionDeadline) ?? undefined} />
            </ActionForm>
          </Disclosure>
        ) : null}

        {p.changeReversibility ? (
          <Disclosure title={`Change to ${REVERSIBILITY_LABELS[changeTo].toLowerCase()}`}>
            <ActionForm action={bind(changeReversibilityAction)} submitLabel="Confirm the change" variant="outline">
              <input type="hidden" name="to" value={changeTo} />
              {changeTo === "one_way" ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {view.status === "objection_round"
                      ? `The proposal returns to the feedback phase with at least ${MINIMUM_PERIODS.one_way.feedback} working days.`
                      : `The feedback phase lasts at least ${MINIMUM_PERIODS.one_way.feedback} working days from submission.`}
                  </p>
                  <Label htmlFor="type-reason">Why one-way</Label>
                  <Textarea id="type-reason" name="reversibilityReason" rows={2} required />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Consent givers become feedback givers.</p>
              )}
              <Label htmlFor="change-reason">Reason for the change</Label>
              <Input id="change-reason" name="reason" required />
              {changeTo === "one_way" ? (
                <>
                  <Label htmlFor="type-consent-givers">Consent givers</Label>
                  <OptionPicker
                    id="type-consent-givers"
                    name="consentGiverIds"
                    multiple
                    options={people.filter((person) => mayGiveConsent(view.proposer.id, person.id).ok)}
                    placeholder="Choose consent givers"
                  />
                </>
              ) : null}
            </ActionForm>
          </Disclosure>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Threads({ view, bind }: { view: ProposalView; bind: Bind }) {
  const p = view.permissions;
  const kinds = [
    p.ask ? { value: "question", label: "Question" } : null,
    p.giveFeedback ? { value: "feedback", label: "Feedback" } : null,
    p.object ? { value: "objection", label: "Objection" } : null,
  ].filter((k): k is { value: string; label: string } => k !== null);

  return (
    <section aria-labelledby="threads" className="flex flex-col gap-6">
      <h2 id="threads" className="text-lg font-semibold">
        Questions, feedback, and objections
      </h2>

      {kinds.length > 0 ? (
        <Card className="py-4">
          <CardContent className="px-4">
            <ActionForm action={bind(postResponseAction)} submitLabel="Post">
              <Label htmlFor="response-kind">Type</Label>
              <NativeSelect id="response-kind" name="kind" defaultValue={kinds[0]!.value} wrapperClassName="w-full" className="w-full">
                {kinds.map((kind) => (
                  <NativeSelectOption key={kind.value} value={kind.value}>
                    {kind.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <PersonalDataNotice />
              <Label htmlFor="response-text">Text</Label>
              <Textarea id="response-text" name="text" rows={4} required />
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}

      <Thread title="Questions" empty="No questions.">
        {view.questions.map((question) => (
          <ThreadItem key={question.id}>
            <Meta name={question.personName} at={question.createdAt} version={question.versionNumber} />
            <p className="whitespace-pre-wrap">{question.text}</p>
            {question.answer ? (
              <div className="border-l-2 pl-3">
                <Meta name={question.answer.personName} at={question.answer.createdAt} />
                <p className="whitespace-pre-wrap">{question.answer.text}</p>
              </div>
            ) : p.answer ? (
              <ActionForm action={bind(answerAction)} submitLabel="Answer" variant="outline">
                <input type="hidden" name="questionId" value={question.id} />
                <Textarea name="text" aria-label="Answer" rows={2} required />
              </ActionForm>
            ) : (
              <p className="text-xs text-muted-foreground">Not answered yet.</p>
            )}
          </ThreadItem>
        ))}
      </Thread>

      <Thread title="Feedback" empty="No feedback yet.">
        {view.feedback.map((item) => (
          <ThreadItem key={item.id}>
            <Meta name={item.personName} at={item.createdAt} version={item.versionNumber} />
            <p className="whitespace-pre-wrap">{item.text}</p>
          </ThreadItem>
        ))}
      </Thread>

      <Thread title="Objections" empty="No objections.">
        {view.objections.map((objection) => (
          <ThreadItem key={objection.id}>
            <div className="flex flex-wrap items-center gap-2">
              <Meta name={objection.personName} at={objection.createdAt} version={objection.versionNumber} />
              {objection.blocking ? <Badge variant="destructive">Blocking</Badge> : objection.open ? <Badge variant="secondary">Open</Badge> : <Badge variant="outline">Resolved</Badge>}
            </div>
            <p className="whitespace-pre-wrap">{objection.text}</p>
            {objection.resolutionNote ? <p className="text-xs text-muted-foreground">Resolved: {objection.resolutionNote}</p> : null}
            {objection.open && objection.mayResolve ? (
              <ActionForm action={bind(resolveObjectionAction)} submitLabel="Mark my objection resolved" variant="outline">
                <input type="hidden" name="responseId" value={objection.id} />
                <Input name="note" aria-label="How it was resolved" placeholder="How it was resolved (optional)" />
              </ActionForm>
            ) : null}
          </ThreadItem>
        ))}
      </Thread>

      {view.gos.length > 0 ? (
        <Thread title="Go" empty="">
          {view.gos.map((go) => (
            <ThreadItem key={go.id}>
              <div className="flex flex-wrap items-center gap-2">
                <Meta name={go.personName} at={go.createdAt} version={go.versionNumber} />
                {go.withdrawnAt ? <Badge variant="outline">Withdrawn</Badge> : go.current ? <Badge>Current version</Badge> : <Badge variant="secondary">Older version</Badge>}
              </div>
              {go.text ? <p className="whitespace-pre-wrap">{go.text}</p> : null}
            </ThreadItem>
          ))}
        </Thread>
      ) : null}
    </section>
  );
}

function Thread({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : <ol className="flex flex-col gap-2">{children}</ol>}
    </div>
  );
}

/** One question, feedback, objection, or Go. */
function ThreadItem({ children }: { children: React.ReactNode }) {
  return (
    <Item asChild variant="outline" size="sm" className="flex-col items-stretch gap-2">
      <li>{children}</li>
    </Item>
  );
}

async function Meta({ name, at, version }: { name: string; at: Date; version?: number }) {
  const fmt = await getFormatter();
  return (
    <p className="text-xs text-muted-foreground">
      {name} · {fmt.dateTime(at)}
      {version ? ` · version ${version}` : null}
    </p>
  );
}
