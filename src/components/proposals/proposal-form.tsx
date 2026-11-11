"use client";

import { useState } from "react";
import { ImpactField, ReversibilityField, TeamField } from "@/components/entries/entry-fields";
import { describedBy, Field, FormError } from "@/components/form/field";
import { EntryPicker, type EntryOption } from "@/components/form/entry-picker";
import { LinksField } from "@/components/form/links-field";
import { MarkdownField } from "@/components/form/markdown-field";
import { OptionPicker, type PickerOption } from "@/components/form/option-picker";
import { useFormAction } from "@/components/form/use-form-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SUMMARY_MAX, TITLE_MAX, type Impact, type Reversibility } from "@/lib/entries/constants";
import { createDateFormatter } from "@/lib/format";
import type { DateFormat } from "@/lib/preferences";
import type { FormState } from "@/lib/form-state";
import { mayGiveConsent } from "@/lib/process/rules";
import { QUESTION_MAX } from "@/lib/process/schemas";

export interface PeriodDefaults {
  feedbackDeadline: string;
  minimumFeedbackDeadline: string;
  objectionPeriodDays: number;
  minimumObjectionPeriodDays: number;
}

export interface ProposalFormValues {
  title?: string;
  question?: string;
  summary?: string;
  body?: string;
  impact?: Impact;
  proposalText?: string;
  reversibility?: Reversibility;
  reversibilityReason?: string;
  deciderId?: string;
  consentGiverIds?: string[];
  feedbackGiverIds?: string[];
  affectedTeamIds?: string[];
  teamId?: string;
  tagIds?: string[];
  feedbackDeadline?: string;
  objectionPeriodDays?: number;
  supersedes?: EntryOption;
  reviewDate?: string;
  links?: string[];
  related?: EntryOption[];
}

interface ProposalFormProps {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  options: { teams: PickerOption[]; tags: PickerOption[]; people: PickerOption[] };
  defaults: ProposalFormValues;
  periodDefaults: Record<Reversibility, PeriodDefaults>;
  /** The proposer, who cannot be a consent giver (`mayGiveConsent`). */
  proposerId: string;
  /** The viewer's date format. */
  dateFormat: DateFormat;
  /** When a deadline day ends, with the server's time zone, e.g. "23:59 (Europe/Vienna)". */
  deadlineEnd: string;
}

/** What two-way and one-way mean in the decision process. */
const PROCESS_HELP: Record<Reversibility, string> = {
  two_way: "Objections are recorded and must be considered, but do not block.",
  one_way: "Consent givers you choose must each give a Go.",
};

/**
 * The proposal form in the order of the decision process: Question,
 * Proposal, Reversibility, People, Deadlines, Details. Saving creates a
 * private draft; the draft page shows the preview and submits it.
 */
export function ProposalForm({ action, options, defaults, periodDefaults, proposerId, dateFormat, deadlineEnd }: ProposalFormProps) {
  const { state, onSubmit, pending } = useFormAction(action);
  const errors = state.fieldErrors ?? {};
  const [reversibility, setReversibility] = useState<Reversibility>(defaults.reversibility ?? "two_way");
  const current = periodDefaults[reversibility];
  // Deadlines follow two-way or one-way until the proposer changes them.
  const [deadline, setDeadline] = useState(defaults.feedbackDeadline ?? current.feedbackDeadline);
  const [period, setPeriod] = useState(String(defaults.objectionPeriodDays ?? current.objectionPeriodDays));
  const [touched, setTouched] = useState({ deadline: Boolean(defaults.feedbackDeadline), period: defaults.objectionPeriodDays !== undefined });
  const consentOptions = options.people.filter((p) => mayGiveConsent(proposerId, p.id).ok);

  function chooseReversibility(next: Reversibility) {
    setReversibility(next);
    if (!touched.deadline || deadline < periodDefaults[next].minimumFeedbackDeadline) setDeadline(periodDefaults[next].feedbackDeadline);
    if (!touched.period || Number(period) < periodDefaults[next].minimumObjectionPeriodDays) {
      setPeriod(String(periodDefaults[next].objectionPeriodDays));
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <FormError message={state.formError} />

      <Section number={1} title="Question">
        <Field id="title" label="Title" required error={errors.title}>
          <Input id="title" name="title" required maxLength={TITLE_MAX} defaultValue={defaults.title} aria-invalid={errors.title ? true : undefined} aria-describedby={describedBy("title", errors.title)} />
        </Field>
        <Field id="question" label="Question" required hint="Which question should be decided?" error={errors.question}>
          <Input id="question" name="question" required maxLength={QUESTION_MAX} defaultValue={defaults.question} aria-invalid={errors.question ? true : undefined} aria-describedby={describedBy("question", errors.question, "hint")} />
        </Field>
        <Field id="summary" label="Summary" hint={`Up to ${SUMMARY_MAX} characters, shown in the timeline and the Slack post. Without one, the question is the summary. The decider can revise it on publish.`} error={errors.summary}>
          <Input id="summary" name="summary" maxLength={SUMMARY_MAX} defaultValue={defaults.summary} aria-invalid={errors.summary ? true : undefined} aria-describedby={describedBy("summary", errors.summary, "hint")} />
        </Field>
        <Field id="body" label="Context" required hint="The tension: why this matters now." error={errors.body}>
          <MarkdownField id="body" name="body" rows={5} defaultValue={defaults.body} invalid={!!errors.body} describedBy={describedBy("body", errors.body, "hint")} />
        </Field>
      </Section>

      <Section number={2} title="Proposal">
        <Field id="proposalText" label="Proposal" required hint="Each change after submitting becomes a new version." error={errors.proposalText}>
          <MarkdownField id="proposalText" name="proposalText" rows={8} defaultValue={defaults.proposalText} invalid={!!errors.proposalText} describedBy={describedBy("proposalText", errors.proposalText, "hint")} />
        </Field>
      </Section>

      <Section number={3} title="Reversibility">
        <ReversibilityField value={reversibility} onChange={chooseReversibility} help={PROCESS_HELP} error={errors.reversibility} />
        {reversibility === "one_way" ? (
          <Field id="reversibilityReason" label="Why one-way" required hint="Why is it hard to reverse?" error={errors.reversibilityReason}>
            <Textarea id="reversibilityReason" name="reversibilityReason" rows={2} defaultValue={defaults.reversibilityReason} aria-invalid={errors.reversibilityReason ? true : undefined} aria-describedby={describedBy("reversibilityReason", errors.reversibilityReason, "hint")} />
          </Field>
        ) : null}
      </Section>

      <Section number={4} title="People">
        <div className="grid gap-6 sm:grid-cols-2">
          <Field id="deciderId" label="Decider" required hint="Publishes the decision once the criteria are met." error={errors.deciderId}>
            <OptionPicker id="deciderId" name="deciderId" options={options.people} defaultValue={[defaults.deciderId ?? proposerId]} placeholder="Choose the decider" invalid={!!errors.deciderId} describedBy={describedBy("deciderId", errors.deciderId, "hint")} />
          </Field>
          {reversibility === "one_way" ? (
            <Field id="consentGiverIds" label="Consent givers" required hint="Each must give a Go before the decision." error={errors.consentGiverIds}>
              <OptionPicker id="consentGiverIds" name="consentGiverIds" multiple options={consentOptions} defaultValue={defaults.consentGiverIds} placeholder="Choose consent givers" invalid={!!errors.consentGiverIds} describedBy={describedBy("consentGiverIds", errors.consentGiverIds, "hint")} />
            </Field>
          ) : null}
          <Field id="feedbackGiverIds" label="Feedback from" hint="Recommended. They are asked for feedback." error={errors.feedbackGiverIds}>
            <OptionPicker id="feedbackGiverIds" name="feedbackGiverIds" multiple options={options.people} defaultValue={defaults.feedbackGiverIds} placeholder="Choose people" invalid={!!errors.feedbackGiverIds} describedBy={describedBy("feedbackGiverIds", errors.feedbackGiverIds, "hint")} />
          </Field>
          <Field id="affectedTeamIds" label="Affected teams" error={errors.affectedTeamIds}>
            <OptionPicker id="affectedTeamIds" name="affectedTeamIds" multiple options={options.teams} defaultValue={defaults.affectedTeamIds} placeholder="Choose teams" invalid={!!errors.affectedTeamIds} describedBy={describedBy("affectedTeamIds", errors.affectedTeamIds)} />
          </Field>
        </div>
      </Section>

      <Section number={5} title="Deadlines">
        <div className="grid gap-6 sm:grid-cols-2">
          <Field id="feedbackDeadline" label="Feedback deadline" required hint={`Earliest ${createDateFormatter({ dateFormat }).date(current.minimumFeedbackDeadline)}, if submitted today. Ends at ${deadlineEnd}.`} error={errors.feedbackDeadline}>
            <Input
              id="feedbackDeadline"
              name="feedbackDeadline"
              type="date"
              required
              min={current.minimumFeedbackDeadline}
              value={deadline}
              onChange={(event) => {
                setDeadline(event.target.value);
                setTouched((t) => ({ ...t, deadline: true }));
              }}
              aria-invalid={errors.feedbackDeadline ? true : undefined}
              aria-describedby={describedBy("feedbackDeadline", errors.feedbackDeadline, "hint")}
            />
          </Field>
          <Field id="objectionPeriodDays" label="Objection period (working days)" required hint={`At least ${current.minimumObjectionPeriodDays}. The deadline is set when the objection round starts.`} error={errors.objectionPeriodDays}>
            <Input
              id="objectionPeriodDays"
              name="objectionPeriodDays"
              type="number"
              required
              min={current.minimumObjectionPeriodDays}
              max={60}
              value={period}
              onChange={(event) => {
                setPeriod(event.target.value);
                setTouched((t) => ({ ...t, period: true }));
              }}
              aria-invalid={errors.objectionPeriodDays ? true : undefined}
              aria-describedby={describedBy("objectionPeriodDays", errors.objectionPeriodDays, "hint")}
            />
          </Field>
        </div>
      </Section>

      <Section number={6} title="Details">
        <ImpactField defaultValue={defaults.impact} enforce={false} error={errors.impact} />
        <TeamField teams={options.teams} defaultValue={defaults.teamId} error={errors.teamId} />
        <div className="grid gap-6 sm:grid-cols-2">
          <Field id="tagIds" label="Tags" error={errors.tagIds}>
            <OptionPicker id="tagIds" name="tagIds" multiple options={options.tags} defaultValue={defaults.tagIds} placeholder={options.tags.length > 0 ? "Choose tags" : "No tags yet"} invalid={!!errors.tagIds} describedBy={describedBy("tagIds", errors.tagIds)} />
          </Field>
          <Field id="supersedesId" label="Supersedes" hint="The decision this proposal replaces. A one-way decision can only be replaced by a one-way proposal." error={errors.supersedesId}>
            <EntryPicker id="supersedesId" name="supersedesId" mode="supersedes" defaultValue={defaults.supersedes ? [defaults.supersedes] : []} placeholder="Choose a decision" invalid={!!errors.supersedesId} describedBy={describedBy("supersedesId", errors.supersedesId, "hint")} />
          </Field>
          <Field id="reviewDate" label="Review date" hint={reversibility === "two_way" ? "Recommended: when to check whether it works." : undefined} error={errors.reviewDate}>
            <Input id="reviewDate" name="reviewDate" type="date" defaultValue={defaults.reviewDate} aria-invalid={errors.reviewDate ? true : undefined} aria-describedby={describedBy("reviewDate", errors.reviewDate, reversibility === "two_way" ? "hint" : undefined)} />
          </Field>
        </div>
        <Field id="links" label="Links" error={errors.links}>
          <LinksField id="links" defaultValue={defaults.links} describedBy={describedBy("links", errors.links)} />
        </Field>
        <Field id="relatedIds" label="Related entries" error={errors.relatedIds}>
          <EntryPicker id="relatedIds" name="relatedIds" mode="related" multiple defaultValue={defaults.related} placeholder="Choose related entries" invalid={!!errors.relatedIds} describedBy={describedBy("relatedIds", errors.relatedIds)} />
        </Field>
      </Section>

      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">The draft is private until you submit it. Next you see a preview.</p>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save draft and preview"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function Section({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <Card role="region" aria-labelledby={`step-${number}`}>
      <CardHeader>
        <CardTitle>
          <h2 id={`step-${number}`} className="flex items-center gap-2 text-lg">
            <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground tabular-nums" aria-hidden="true">
              {number}
            </span>
            {title}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">{children}</CardContent>
    </Card>
  );
}
