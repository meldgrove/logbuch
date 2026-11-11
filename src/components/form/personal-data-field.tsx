"use client";

import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { PERSONAL_DATA_CONFIRMATION, PERSONAL_DATA_NOTICE } from "@/lib/entries/constants";

/**
 * The personal data notice and its required checkbox. Unchecked by
 * default and checked again on the server.
 */
export function PersonalDataField({ error }: { error?: string }) {
  const id = useId();
  const noticeId = `${id}-notice`;
  const errorId = `${id}-error`;
  return (
    <Field
      orientation="horizontal"
      data-invalid={error ? true : undefined}
      className="items-start rounded-lg border border-amber-500/40 bg-amber-50 p-4 dark:bg-amber-950/30"
    >
      <Checkbox
        id={id}
        name="personalDataConfirmed"
        required
        className="mt-0.5 bg-background"
        aria-describedby={error ? `${noticeId} ${errorId}` : noticeId}
        aria-invalid={error ? true : undefined}
      />
      <FieldContent>
        <FieldLabel htmlFor={id}>{PERSONAL_DATA_CONFIRMATION}</FieldLabel>
        <FieldDescription id={noticeId} className="text-foreground/80">
          {PERSONAL_DATA_NOTICE}
        </FieldDescription>
        {error ? <FieldError id={errorId}>{error}</FieldError> : null}
      </FieldContent>
    </Field>
  );
}

/** The notice alone, above question, feedback, and objection fields. */
export function PersonalDataNotice() {
  return <p className="text-xs text-muted-foreground">{PERSONAL_DATA_NOTICE}</p>;
}
