"use client";

import { useState } from "react";
import type { FormState } from "@/app/(app)/entry-actions";
import { ChoiceField, ImpactField, ReversibilityField, TeamField } from "@/components/entries/entry-fields";
import { describedBy, Field, FormError } from "@/components/form/field";
import { EntryPicker, type EntryOption } from "@/components/form/entry-picker";
import { LinksField } from "@/components/form/links-field";
import { MarkdownField } from "@/components/form/markdown-field";
import { OptionPicker, type PickerOption } from "@/components/form/option-picker";
import { PersonalDataField } from "@/components/form/personal-data-field";
import { useFormAction } from "@/components/form/use-form-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  HOW_DECIDED,
  HOW_DECIDED_LABELS,
  SUMMARY_MAX,
  TITLE_MAX,
  TYPE_HELP,
  TYPE_LABELS,
  type EntryType,
  type Impact,
  type Reversibility,
} from "@/lib/entries/constants";

export interface LogFormValues {
  type?: EntryType;
  title?: string;
  summary?: string;
  body?: string;
  rationale?: string;
  impact?: Impact;
  teamId?: string;
  affectedTeamIds?: string[];
  tagIds?: string[];
  links?: string[];
  related?: EntryOption[];
  deciderId?: string;
  decidedOn?: string;
}

interface LogFormProps {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  options: { teams: PickerOption[]; tags: PickerOption[]; people: PickerOption[] };
  defaults: LogFormValues;
  /** The types to choose from: all three when logging, Update and Learning when editing. */
  types: EntryType[];
  /** Today in the server's time zone: a decision cannot be dated later. */
  today: string;
  /** The entry being edited, so it is not offered as related to itself. */
  entryId?: string;
  /** Overrides the publish button, e.g. "Save changes". */
  submitLabel?: string;
}

const PUBLISH_LABELS: Record<EntryType, string> = {
  update: "Publish update",
  decision: "Publish decision",
  learning: "Publish learning",
};

/**
 * "Log something": one form for updates, decisions, and
 * learnings. The fields follow the chosen type; fields every type shares
 * keep their input when the type changes.
 */
export function LogForm({ action, options, defaults, types, today, entryId, submitLabel }: LogFormProps) {
  const { state, onSubmit, pending } = useFormAction(action);
  const errors = state.fieldErrors ?? {};
  const [type, setType] = useState<EntryType | undefined>(defaults.type ?? (types.length === 1 ? types[0] : undefined));
  const [reversibility, setReversibility] = useState<Reversibility>("two_way");
  const isDecision = type === "decision";

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <FormError message={state.formError} />
      <ChoiceField
        name="type"
        legend="What do you want to log?"
        choices={types.map((value) => ({ value, label: TYPE_LABELS[value], help: TYPE_HELP[value] }))}
        value={type}
        onChange={setType}
        required
        columns={types.length === 3 ? 3 : 1}
        error={errors.type}
      />

      <Field id="title" label="Title" required error={errors.title}>
        <Input
          id="title"
          name="title"
          required
          maxLength={TITLE_MAX}
          defaultValue={defaults.title}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={describedBy("title", errors.title)}
        />
      </Field>
      <Field id="summary" label="Summary" required hint={`Up to ${SUMMARY_MAX} characters. Shown in the timeline and the Slack post.`} error={errors.summary}>
        <Input
          id="summary"
          name="summary"
          required
          maxLength={SUMMARY_MAX}
          defaultValue={defaults.summary}
          aria-invalid={errors.summary ? true : undefined}
          aria-describedby={describedBy("summary", errors.summary, "hint")}
        />
      </Field>
      <Field
        id="body"
        label={isDecision ? "Context" : "Details"}
        hint={isDecision ? "The situation or tension behind the decision." : undefined}
        error={errors.body}
      >
        <MarkdownField
          id="body"
          name="body"
          defaultValue={defaults.body}
          invalid={!!errors.body}
          describedBy={describedBy("body", errors.body, isDecision ? "hint" : undefined)}
        />
      </Field>
      {isDecision ? (
        <Field id="decisionText" label="Decision text" required error={errors.decisionText}>
          <MarkdownField
            id="decisionText"
            name="decisionText"
            required
            rows={6}
            invalid={!!errors.decisionText}
            describedBy={describedBy("decisionText", errors.decisionText)}
          />
        </Field>
      ) : null}
      <Field id="rationale" label="Rationale" required={isDecision} hint="Why." error={errors.rationale}>
        <MarkdownField
          id="rationale"
          name="rationale"
          required={isDecision}
          rows={4}
          defaultValue={defaults.rationale}
          invalid={!!errors.rationale}
          describedBy={describedBy("rationale", errors.rationale, "hint")}
        />
      </Field>

      {isDecision ? (
        <DecisionFields
          options={options}
          defaults={defaults}
          today={today}
          errors={errors}
          reversibility={reversibility}
          onReversibility={setReversibility}
        />
      ) : null}

      <ImpactField defaultValue={defaults.impact} error={errors.impact} />

      <TeamField teams={options.teams} defaultValue={defaults.teamId} error={errors.teamId} />
      <div className="grid gap-6 sm:grid-cols-2">
        <Field id="affectedTeamIds" label="Affected teams" error={errors.affectedTeamIds}>
          <OptionPicker
            id="affectedTeamIds"
            name="affectedTeamIds"
            multiple
            options={options.teams}
            defaultValue={defaults.affectedTeamIds}
            placeholder="Choose teams"
            invalid={!!errors.affectedTeamIds}
            describedBy={describedBy("affectedTeamIds", errors.affectedTeamIds)}
          />
        </Field>
        <Field id="tagIds" label="Tags" error={errors.tagIds}>
          <OptionPicker
            id="tagIds"
            name="tagIds"
            multiple
            options={options.tags}
            defaultValue={defaults.tagIds}
            placeholder={options.tags.length > 0 ? "Choose tags" : "No tags yet"}
            invalid={!!errors.tagIds}
            describedBy={describedBy("tagIds", errors.tagIds)}
          />
        </Field>
      </div>
      <Field id="links" label="Links" error={errors.links}>
        <LinksField id="links" defaultValue={defaults.links} describedBy={describedBy("links", errors.links)} />
      </Field>
      <Field id="relatedIds" label="Related entries" error={errors.relatedIds}>
        <EntryPicker
          id="relatedIds"
          name="relatedIds"
          mode="related"
          multiple
          excludeId={entryId}
          defaultValue={defaults.related}
          placeholder="Choose related entries"
          invalid={!!errors.relatedIds}
          describedBy={describedBy("relatedIds", errors.relatedIds)}
        />
      </Field>
      <PersonalDataField error={errors.personalDataConfirmed} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : (submitLabel ?? (type ? PUBLISH_LABELS[type] : "Publish"))}
        </Button>
      </div>
    </form>
  );
}

/** The fields of a decision logged directly. */
function DecisionFields({
  options,
  defaults,
  today,
  errors,
  reversibility,
  onReversibility,
}: {
  options: LogFormProps["options"];
  defaults: LogFormValues;
  today: string;
  errors: Record<string, string>;
  reversibility: Reversibility;
  onReversibility: (value: Reversibility) => void;
}) {
  return (
    <>
      <ReversibilityField value={reversibility} onChange={onReversibility} error={errors.reversibility} />
      {reversibility === "one_way" ? (
        <Field id="reversibilityReason" label="Why one-way" required hint="Why is it hard to reverse?" error={errors.reversibilityReason}>
          <Textarea
            id="reversibilityReason"
            name="reversibilityReason"
            rows={2}
            required
            aria-invalid={errors.reversibilityReason ? true : undefined}
            aria-describedby={describedBy("reversibilityReason", errors.reversibilityReason, "hint")}
          />
        </Field>
      ) : null}
      <div className="grid gap-6 sm:grid-cols-2">
        <Field id="howDecided" label="How it was decided" required error={errors.howDecided}>
          <NativeSelect
            id="howDecided"
            name="howDecided"
            required
            className="w-full"
            wrapperClassName="w-full"
            defaultValue=""
            aria-invalid={errors.howDecided ? true : undefined}
            aria-describedby={describedBy("howDecided", errors.howDecided)}
          >
            <NativeSelectOption value="" disabled>
              Choose…
            </NativeSelectOption>
            {HOW_DECIDED.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {HOW_DECIDED_LABELS[value]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field id="decidedOn" label="Decided on" required error={errors.decidedOn}>
          <Input
            id="decidedOn"
            name="decidedOn"
            type="date"
            required
            max={today}
            defaultValue={defaults.decidedOn ?? today}
            aria-invalid={errors.decidedOn ? true : undefined}
            aria-describedby={describedBy("decidedOn", errors.decidedOn)}
          />
        </Field>
        <Field id="deciderId" label="Decider" required error={errors.deciderId}>
          <OptionPicker
            id="deciderId"
            name="deciderId"
            options={options.people}
            defaultValue={[defaults.deciderId ?? ""]}
            placeholder="Choose the decider"
            invalid={!!errors.deciderId}
            describedBy={describedBy("deciderId", errors.deciderId)}
          />
        </Field>
        <Field id="involvedIds" label="Involved people" error={errors.involvedIds}>
          <OptionPicker
            id="involvedIds"
            name="involvedIds"
            multiple
            options={options.people}
            placeholder="Choose people"
            invalid={!!errors.involvedIds}
            describedBy={describedBy("involvedIds", errors.involvedIds)}
          />
        </Field>
        <Field id="effectiveDate" label="Effective date" error={errors.effectiveDate}>
          <Input
            id="effectiveDate"
            name="effectiveDate"
            type="date"
            aria-invalid={errors.effectiveDate ? true : undefined}
            aria-describedby={describedBy("effectiveDate", errors.effectiveDate)}
          />
        </Field>
        <Field
          id="reviewDate"
          label="Review date"
          hint={reversibility === "two_way" ? "Recommended: when to check whether it works. You get a reminder." : "You get a reminder."}
          error={errors.reviewDate}
        >
          <Input
            id="reviewDate"
            name="reviewDate"
            type="date"
            aria-invalid={errors.reviewDate ? true : undefined}
            aria-describedby={describedBy("reviewDate", errors.reviewDate, "hint")}
          />
        </Field>
      </div>
      <Field
        id="supersedesId"
        label="Supersedes"
        hint="The earlier decision this one replaces. It stays in the log, marked as replaced. A one-way decision can only be replaced through a one-way proposal."
        error={errors.supersedesId}
      >
        <EntryPicker
          id="supersedesId"
          name="supersedesId"
          mode="supersedes"
          placeholder="Choose a decision"
          invalid={!!errors.supersedesId}
          describedBy={describedBy("supersedesId", errors.supersedesId, "hint")}
        />
      </Field>
    </>
  );
}
