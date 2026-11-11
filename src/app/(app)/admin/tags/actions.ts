"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/(app)/entry-actions";
import { requireAdmin } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { createTag, EntryError, renameTag, setTagActive, type Actor } from "@/lib/entries/commands";
import { fieldErrorsOf, tagInputSchema } from "@/lib/entries/schemas";
import { boundValues, INVALID_BOUND_VALUES } from "@/lib/form-actions";
import { consumeRateLimit, RateLimitError, WRITE_LIMIT } from "@/lib/rate-limit";

async function adminActor(): Promise<Actor> {
  const { person } = await requireAdmin();
  return { personId: person.id, isAdmin: person.isAdmin };
}

/** Every write counts against the person's limit. */
function countWrite(actor: Actor) {
  return consumeRateLimit(getDb(), `write:${actor.personId}`, WRITE_LIMIT);
}

function errorState(error: unknown): FormState {
  if (error instanceof EntryError) {
    return { fieldErrors: error.fieldErrors, formError: Object.keys(error.fieldErrors).length ? undefined : error.message };
  }
  if (error instanceof RateLimitError) return { formError: error.message };
  throw error;
}

export async function createTagAction(_state: FormState, formData: FormData): Promise<FormState> {
  const actor = await adminActor();
  const parsed = tagInputSchema.safeParse({ name: String(formData.get("name") ?? "") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  try {
    await countWrite(actor);
    await createTag(getDb(), actor, parsed.data);
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/admin/tags");
  return { done: true };
}

export async function renameTagAction(tagId: string, _state: FormState, formData: FormData): Promise<FormState> {
  const actor = await adminActor();
  if (!boundValues.id.safeParse([tagId]).success) return INVALID_BOUND_VALUES;
  const parsed = tagInputSchema.safeParse({ name: String(formData.get("name") ?? "") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  try {
    await countWrite(actor);
    await renameTag(getDb(), actor, tagId, parsed.data);
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/admin/tags");
  return { done: true };
}

/** Activate or deactivate a tag. */
export async function setTagActiveAction(tagId: string, isActive: boolean, _state: FormState): Promise<FormState> {
  const actor = await adminActor();
  if (!boundValues.idAndFlag.safeParse([tagId, isActive]).success) return INVALID_BOUND_VALUES;
  try {
    await countWrite(actor);
    await setTagActive(getDb(), actor, tagId, isActive);
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/admin/tags");
  return { done: true };
}
