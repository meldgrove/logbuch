"use server";

import { getDb } from "@/lib/db/client";
import { savePreferences } from "@/lib/directory/manage";
import { preferencesSchema } from "@/lib/directory/schemas";
import { handleFormAction as submit } from "@/lib/form-actions";
import type { FormState } from "@/lib/form-state";

/** Saves the signed-in person's time zone and date format. */
export async function savePreferencesAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, preferencesSchema, async (actor, input) => {
    await savePreferences(getDb(), actor.personId, input);
    return "/settings";
  });
}
