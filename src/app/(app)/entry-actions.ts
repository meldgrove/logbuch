"use server";

import { getDb } from "@/lib/db/client";
import { addAddendum, changeImpact, createNote, editNote, logDecision } from "@/lib/entries/commands";
import { entryPath } from "@/lib/entries/refs";
import { addendumInputSchema, impactInputSchema, logInputSchema, noteInputSchema } from "@/lib/entries/schemas";
import { boundValues, handleFormAction as submit } from "@/lib/form-actions";
import type { FormState } from "@/lib/form-state";

export type { FormState };

/** "Log something": an update, decision, or learning, published right away. */
export async function logEntryAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, logInputSchema, async (actor, input) => {
    const created = input.type === "decision" ? await logDecision(getDb(), actor, input) : await createNote(getDb(), actor, input);
    return entryPath(created.number);
  });
}

/** The author corrects an update or learning; every save is a new revision. */
export async function editNoteAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noteInputSchema, async (actor, input) => {
    await editNote(getDb(), actor, entryId, input);
    return entryPath(number);
  }, boundValues.entry.safeParse([entryId, number]));
}

export async function changeImpactAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, impactInputSchema, async (actor, input) => {
    await changeImpact(getDb(), actor, entryId, input.impact);
    return entryPath(number);
  }, boundValues.entry.safeParse([entryId, number]));
}

export async function addAddendumAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, addendumInputSchema, async (actor, input) => {
    await addAddendum(getDb(), actor, entryId, input);
    return `${entryPath(number)}#addenda`;
  }, boundValues.entry.safeParse([entryId, number]));
}
