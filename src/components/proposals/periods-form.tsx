"use client";

import { savePeriodsAction } from "@/app/(app)/proposal-actions";
import { useFormAction } from "@/components/form/use-form-action";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { DefaultPeriods } from "@/lib/process/settings";

const FIELDS = [
  { name: "twoWayFeedback", key: "two_way.feedback", label: "Two-way: feedback", min: 1 },
  { name: "twoWayObjection", key: "two_way.objection", label: "Two-way: objection round", min: 1 },
  { name: "oneWayFeedback", key: "one_way.feedback", label: "One-way: feedback", min: 5 },
  { name: "oneWayObjection", key: "one_way.objection", label: "One-way: objection round", min: 3 },
] as const;

/** Admins set the default periods in working days, never below the minimums. */
export function PeriodsForm({ periods }: { periods: DefaultPeriods }) {
  const { state, onSubmit, pending } = useFormAction(savePeriodsAction);
  const values: Record<string, number> = {
    twoWayFeedback: periods.two_way.feedback,
    twoWayObjection: periods.two_way.objection,
    oneWayFeedback: periods.one_way.feedback,
    oneWayObjection: periods.one_way.objection,
  };
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => {
          const error = state.fieldErrors?.[field.key];
          return (
            <Field key={field.name} data-invalid={error ? true : undefined} className="gap-1.5">
              <FieldLabel htmlFor={field.name}>{field.label}</FieldLabel>
              <Input
                id={field.name}
                name={field.name}
                type="number"
                min={field.min}
                max={60}
                required
                defaultValue={values[field.name]}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${field.name}-hint${error ? ` ${field.name}-error` : ""}`}
              />
              <FieldDescription id={`${field.name}-hint`} className="text-xs">
                At least {field.min} working {field.min === 1 ? "day" : "days"}.
              </FieldDescription>
              {error ? <FieldError id={`${field.name}-error`}>{error}</FieldError> : null}
            </Field>
          );
        })}
      </FieldGroup>
      <p role="status" className="text-sm text-muted-foreground">
        {state.done ? "Saved." : (state.formError ?? "")}
      </p>
      <div>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save periods"}
        </Button>
      </div>
    </form>
  );
}
