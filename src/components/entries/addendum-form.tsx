"use client";

import type { FormState } from "@/app/(app)/entry-actions";
import { describedBy, Field, FormError } from "@/components/form/field";
import { MarkdownField } from "@/components/form/markdown-field";
import { PersonalDataField } from "@/components/form/personal-data-field";
import { useFormAction } from "@/components/form/use-form-action";
import { Button } from "@/components/ui/button";

export function AddendumForm({ action }: { action: (state: FormState, formData: FormData) => Promise<FormState> }) {
  const { state, onSubmit, pending } = useFormAction(action);
  const errors = state.fieldErrors ?? {};
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <FormError message={state.formError} />
      <Field id="addendum" label="Add an addendum" required hint="A correction or addition. The published text stays unchanged." error={errors.text}>
        <MarkdownField
          id="addendum"
          name="text"
          required
          rows={4}
          invalid={!!errors.text}
          describedBy={describedBy("addendum", errors.text, "hint")}
        />
      </Field>
      <PersonalDataField error={errors.personalDataConfirmed} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Adding…" : "Add addendum"}
        </Button>
      </div>
    </form>
  );
}
