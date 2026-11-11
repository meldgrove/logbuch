"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { EntryError, type Actor } from "@/lib/entries/commands";
import { entryPath } from "@/lib/entries/refs";
import { boundValues, handleFormAction } from "@/lib/form-actions";
import type { FormState } from "@/lib/form-state";
import * as proposals from "@/lib/process/commands";
import {
  addParticipantSchema,
  answerSchema,
  changeDeciderSchema,
  changeReversibilitySchema,
  extendSchema,
  goSchema,
  periodsFormSchema,
  proposalDraftSchema,
  publishSchema,
  rejectSchema,
  removeParticipantSchema,
  replaceConsentGiverSchema,
  resolveSchema,
  responseSchema,
  submitSchema,
  versionSchema,
  withdrawSchema,
} from "@/lib/process/schemas";
import { periodErrors, setDefaultPeriods } from "@/lib/process/settings";
import { consumeRateLimit, RateLimitError, WRITE_LIMIT } from "@/lib/rate-limit";

/*
 * Server Actions for proposals. Each checks access, validates, and calls the
 * process module, which enforces the rules of the decision process again.
 */

const empty = z.object({});

/** Run a process step on the entry and come back to the proposal page. */
function step<S extends z.ZodType>(
  entryId: string,
  number: number,
  formData: FormData,
  schema: S,
  write: (actor: Actor, input: z.infer<S>) => Promise<unknown>,
) {
  return handleFormAction(
    formData,
    schema,
    async (actor, input) => {
      await write(actor, input);
      return entryPath(number);
    },
    boundValues.entry.safeParse([entryId, number]),
  );
}

export async function saveDraftAction(draftId: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  return handleFormAction(formData, proposalDraftSchema, async (actor, input) => {
    const saved = await proposals.saveDraft(getDb(), actor, input, draftId ?? undefined);
    return entryPath(saved.number);
  }, boundValues.optionalId.safeParse([draftId]));
}

export async function submitProposalAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, submitSchema, (actor) => proposals.submitProposal(getDb(), actor, entryId));
}

export async function discardDraftAction(entryId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return handleFormAction(formData, empty, async (actor) => {
    await proposals.discardDraft(getDb(), actor, entryId);
    return "/";
  }, boundValues.id.safeParse([entryId]));
}

export async function addVersionAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, versionSchema, (actor, input) => proposals.addVersion(getDb(), actor, entryId, input));
}

export async function postResponseAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, responseSchema, (actor, input) => proposals.postResponse(getDb(), actor, entryId, input));
}

export async function answerAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, answerSchema, (actor, input) => proposals.answerQuestion(getDb(), actor, entryId, input));
}

export async function goAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, goSchema, (actor, input) => proposals.giveGo(getDb(), actor, entryId, input));
}

export async function withdrawGoAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, empty, (actor) => proposals.withdrawGo(getDb(), actor, entryId));
}

export async function resolveObjectionAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, resolveSchema, (actor, input) => proposals.resolveObjection(getDb(), actor, entryId, input));
}

export async function startObjectionRoundAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, empty, (actor) => proposals.startObjectionRound(getDb(), actor, entryId));
}

export async function extendDeadlineAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, extendSchema, (actor, input) => proposals.extendDeadline(getDb(), actor, entryId, input));
}

export async function changeReversibilityAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, changeReversibilitySchema, (actor, input) => proposals.changeReversibility(getDb(), actor, entryId, input));
}

export async function addParticipantAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, addParticipantSchema, (actor, input) => proposals.addParticipant(getDb(), actor, entryId, input));
}

export async function removeParticipantAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, removeParticipantSchema, (actor, input) => proposals.removeParticipant(getDb(), actor, entryId, input));
}

export async function replaceConsentGiverAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, replaceConsentGiverSchema, (actor, input) => proposals.replaceConsentGiver(getDb(), actor, entryId, input));
}

export async function changeDeciderAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, changeDeciderSchema, (actor, input) => proposals.changeDecider(getDb(), actor, entryId, input));
}

export async function publishAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, publishSchema, (actor, input) => proposals.publishDecision(getDb(), actor, entryId, input));
}

export async function rejectAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, rejectSchema, (actor, input) => proposals.rejectProposal(getDb(), actor, entryId, input));
}

export async function withdrawAction(entryId: string, number: number, _state: FormState, formData: FormData): Promise<FormState> {
  return step(entryId, number, formData, withdrawSchema, (actor, input) => proposals.withdrawProposal(getDb(), actor, entryId, input));
}

/** Admins change the default periods; never below the minimums. */
export async function savePeriodsAction(_state: FormState, formData: FormData): Promise<FormState> {
  const { person } = await requireAdmin();
  const parsed = periodsFormSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { formError: "Enter whole working days." };
  const periods = {
    two_way: { feedback: parsed.data.twoWayFeedback, objection: parsed.data.twoWayObjection },
    one_way: { feedback: parsed.data.oneWayFeedback, objection: parsed.data.oneWayObjection },
  };
  const errors = periodErrors(periods);
  if (Object.keys(errors).length > 0) {
    return { fieldErrors: errors, formError: "Some periods are below the minimum." };
  }
  try {
    await consumeRateLimit(getDb(), `write:${person.id}`, WRITE_LIMIT);
    await setDefaultPeriods(getDb(), person.id, periods);
  } catch (error) {
    if (error instanceof EntryError || error instanceof RateLimitError) return { formError: error.message };
    throw error;
  }
  revalidatePath("/admin");
  return { done: true };
}
