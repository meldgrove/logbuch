"use client";

import type { FormState } from "@/app/(app)/entry-actions";
import { describedBy, Field, FormError } from "@/components/form/field";
import { useFormAction } from "@/components/form/use-form-action";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

interface PreferencesFormProps {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  /** The person's time zone; null follows the server. */
  timeZone: string | null;
  dateFormat: string;
  serverTimeZone: string;
  timeZones: string[];
  dateFormats: { value: string; label: string }[];
  /** Now, written with the current settings. */
  example: string;
}

export function PreferencesForm({ action, timeZone, dateFormat, serverTimeZone, timeZones, dateFormats, example }: PreferencesFormProps) {
  const { state, onSubmit, pending } = useFormAction(action);
  const errors = state.fieldErrors ?? {};
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <FormError message={state.formError} />
      <Field id="timeZone" label="Time zone" required error={errors.timeZone} hint={`Now: ${example}`}>
        <NativeSelect
          id="timeZone"
          name="timeZone"
          defaultValue={timeZone ?? ""}
          aria-invalid={errors.timeZone ? true : undefined}
          aria-describedby={describedBy("timeZone", errors.timeZone, "hint")}
          wrapperClassName="w-full"
        >
          <NativeSelectOption value="">Same as Logbuch ({serverTimeZone})</NativeSelectOption>
          {timeZones.map((zone) => (
            <NativeSelectOption key={zone} value={zone}>
              {zone.replaceAll("_", " ")}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field id="dateFormat" label="Date format" required error={errors.dateFormat}>
        <NativeSelect
          id="dateFormat"
          name="dateFormat"
          defaultValue={dateFormat}
          aria-invalid={errors.dateFormat ? true : undefined}
          aria-describedby={describedBy("dateFormat", errors.dateFormat)}
          wrapperClassName="w-full"
        >
          {dateFormats.map((format) => (
            <NativeSelectOption key={format.value} value={format.value}>
              {format.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Button type="submit" disabled={pending} className="self-start">
        Save
      </Button>
    </form>
  );
}
