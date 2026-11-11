"use client";

import { useId, useState } from "react";
import { OptionPicker, type PickerOption } from "@/components/form/option-picker";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  IMPACT_HELP,
  IMPACT_LABELS,
  IMPACTS,
  REVERSIBILITIES,
  REVERSIBILITY_HELP,
  type Impact,
  type Reversibility,
} from "@/lib/entries/constants";

/*
 * Form fields every entry form shares: choices shown as
 * radio cards, the impact, the team, and two-way or one-way.
 */

export interface Choice<T extends string> {
  value: T;
  label: string;
  help?: string;
}

interface ChoiceFieldProps<T extends string> {
  name: string;
  legend: string;
  choices: Choice<T>[];
  /** Controlled when `onChange` is given. */
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  /** Shown as required (no "optional" note). */
  required?: boolean;
  /** The browser checks the choice before submitting; off for drafts. */
  enforce?: boolean;
  hint?: string;
  error?: string;
  columns?: 1 | 3;
}

/** A fieldset of radio cards, each with a label and help text. */
export function ChoiceField<T extends string>({
  name,
  legend,
  choices,
  value,
  defaultValue,
  onChange,
  required,
  enforce = required,
  hint,
  error,
  columns = 1,
}: ChoiceFieldProps<T>) {
  const id = useId();
  const describedBy = [hint ? `${name}-hint` : undefined, error ? `${name}-error` : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <FieldSet aria-describedby={describedBy} data-invalid={error ? true : undefined} className="gap-3">
      <FieldLegend variant="label" className="mb-0">
        {legend}
        {required ? null : <span className="font-normal text-muted-foreground"> (optional)</span>}
      </FieldLegend>
      <RadioGroup
        name={name}
        required={enforce}
        aria-invalid={error ? true : undefined}
        // Controlled with "" before a choice, so the group never switches modes.
        {...(onChange ? { value: value ?? "", onValueChange: (next: string) => onChange(next as T) } : { defaultValue })}
        className={columns === 3 ? "gap-2 sm:grid-cols-3" : "gap-2"}
      >
        {choices.map((choice) => {
          const itemId = `${id}-${choice.value}`;
          return (
            // The whole card selects the choice; the title names it, the help describes it.
            <FieldLabel key={choice.value} htmlFor={itemId} className="has-data-[state=checked]:bg-muted/40 dark:has-data-[state=checked]:bg-muted/40">
              <Field orientation="horizontal" className="p-3!">
                <RadioGroupItem
                  value={choice.value}
                  id={itemId}
                  aria-labelledby={`${itemId}-label`}
                  aria-describedby={choice.help ? `${itemId}-help` : undefined}
                />
                <FieldContent>
                  <FieldTitle id={`${itemId}-label`}>{choice.label}</FieldTitle>
                  {choice.help ? (
                    <FieldDescription id={`${itemId}-help`} className="text-sm">
                      {choice.help}
                    </FieldDescription>
                  ) : null}
                </FieldContent>
              </Field>
            </FieldLabel>
          );
        })}
      </RadioGroup>
      {hint ? (
        <FieldDescription id={`${name}-hint`} className="text-xs">
          {hint}
        </FieldDescription>
      ) : null}
      {error ? <FieldError id={`${name}-error`}>{error}</FieldError> : null}
    </FieldSet>
  );
}

const IMPACT_CHOICES: Choice<Impact>[] = IMPACTS.map((impact) => ({ value: impact, label: IMPACT_LABELS[impact], help: IMPACT_HELP[impact] }));

/** Who needs to know. */
export function ImpactField({ defaultValue, enforce = true, error }: { defaultValue?: Impact; enforce?: boolean; error?: string }) {
  return (
    <ChoiceField
      name="impact"
      legend="Impact"
      choices={IMPACT_CHOICES}
      defaultValue={defaultValue}
      required
      enforce={enforce}
      columns={3}
      hint="Who needs to know about it. Large entries are marked “Must read”."
      error={error}
    />
  );
}

const REVERSIBILITY_CHOICES: Choice<Reversibility>[] = REVERSIBILITIES.map((value) => ({
  value,
  label: REVERSIBILITY_HELP[value].label,
  help: REVERSIBILITY_HELP[value].help,
}));

/** Two-way or one-way. */
export function ReversibilityField({
  value,
  onChange,
  help,
  error,
}: {
  value: Reversibility;
  onChange: (value: Reversibility) => void;
  /** Extra help per choice, e.g. what it means for the decision process. */
  help?: Partial<Record<Reversibility, string>>;
  error?: string;
}) {
  const choices = REVERSIBILITY_CHOICES.map((choice) => ({ ...choice, help: [help?.[choice.value], choice.help].filter(Boolean).join(" ") }));
  return <ChoiceField name="reversibility" legend="Reversibility" choices={choices} value={value} onChange={onChange} required error={error} />;
}

/**
 * The owning team: set from the author's team and shown as "Team: X ·
 * Change". Without a team, the picker shows right away.
 */
export function TeamField({ teams, defaultValue, error }: { teams: PickerOption[]; defaultValue?: string; error?: string }) {
  const current = teams.find((team) => team.id === defaultValue);
  const [changing, setChanging] = useState(!current || Boolean(error));
  const describedBy = error ? "teamId-error" : "teamId-hint";
  return (
    <Field data-invalid={error ? true : undefined} className="gap-2">
      {changing ? (
        <>
          <FieldLabel htmlFor="teamId">Team</FieldLabel>
          <OptionPicker id="teamId" name="teamId" options={teams} defaultValue={[defaultValue ?? ""]} placeholder="Choose a team" invalid={!!error} describedBy={describedBy} />
        </>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <input type="hidden" name="teamId" value={current?.id ?? ""} />
          <span>
            <span className="font-medium">Team:</span> {current?.label}
          </span>
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setChanging(true)}>
            Change
          </Button>
        </p>
      )}
      <FieldDescription id="teamId-hint" className="text-xs">
        The team that owns the entry.
      </FieldDescription>
      {error ? <FieldError id="teamId-error">{error}</FieldError> : null}
    </Field>
  );
}
