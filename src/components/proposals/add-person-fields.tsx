"use client";

import { useState } from "react";
import { OptionPicker, type PickerOption } from "@/components/form/option-picker";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

type Role = "feedback_giver" | "consent_giver";

/**
 * Role and person for adding someone to a proposal. The people offered follow
 * the chosen role: the rules decide who may be added in each (no consent
 * giver role on a two-way proposal, never the proposer as consent giver,
 * nobody twice in one role).
 */
export function AddPersonFields({ options }: { options: { feedback_giver: PickerOption[]; consent_giver?: PickerOption[] } }) {
  const [role, setRole] = useState<Role>("feedback_giver");
  return (
    <>
      <Label htmlFor="add-role">Role</Label>
      <NativeSelect id="add-role" name="role" value={role} onChange={(event) => setRole(event.target.value as Role)} wrapperClassName="w-full" className="w-full">
        <NativeSelectOption value="feedback_giver">Feedback from</NativeSelectOption>
        {options.consent_giver ? <NativeSelectOption value="consent_giver">Consent giver</NativeSelectOption> : null}
      </NativeSelect>
      <Label htmlFor="add-person">Person</Label>
      {/* A new picker per role, so a person chosen for the other role is not submitted. */}
      <OptionPicker key={role} id="add-person" name="personId" options={options[role] ?? []} placeholder="Choose a person" />
    </>
  );
}
