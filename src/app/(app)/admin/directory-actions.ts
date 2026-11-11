"use server";

import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { getDirectory } from "@/lib/directory/directory";
import {
  createTeam,
  invitePerson,
  renameTeam,
  setPersonAccess,
  setPersonAdmin,
  setTeamActive,
  updatePerson,
} from "@/lib/directory/manage";
import { invitePersonSchema, teamInputSchema, updatePersonSchema } from "@/lib/directory/schemas";
import { boundValues, handleFormAction as submit } from "@/lib/form-actions";
import type { FormState } from "@/lib/form-state";

/* People and teams of the manual directory. With the Keycloak directory, the commands refuse every change. */

const noFields = z.object({});

export async function invitePersonAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, invitePersonSchema, async (actor, input) => {
    await invitePerson(getDb(), getDirectory(), actor, input);
    return "/admin/people";
  });
}

export async function updatePersonAction(personId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, updatePersonSchema, async (actor, input) => {
    await updatePerson(getDb(), getDirectory(), actor, personId, input);
    return "/admin/people";
  }, boundValues.id.safeParse([personId]));
}

export async function setPersonAccessAction(personId: string, hasAccess: boolean, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await setPersonAccess(getDb(), getDirectory(), actor, personId, hasAccess);
    return "/admin/people";
  }, boundValues.idAndFlag.safeParse([personId, hasAccess]));
}

export async function setPersonAdminAction(personId: string, isAdmin: boolean, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await setPersonAdmin(getDb(), getDirectory(), actor, personId, isAdmin);
    return "/admin/people";
  }, boundValues.idAndFlag.safeParse([personId, isAdmin]));
}

export async function createTeamAction(_state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, teamInputSchema, async (actor, input) => {
    await createTeam(getDb(), getDirectory(), actor, input);
    return "/admin/teams";
  });
}

export async function renameTeamAction(teamId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, teamInputSchema, async (actor, input) => {
    await renameTeam(getDb(), getDirectory(), actor, teamId, input);
    return "/admin/teams";
  }, boundValues.id.safeParse([teamId]));
}

export async function setTeamActiveAction(teamId: string, isActive: boolean, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(formData, noFields, async (actor) => {
    await setTeamActive(getDb(), getDirectory(), actor, teamId, isActive);
    return "/admin/teams";
  }, boundValues.idAndFlag.safeParse([teamId, isActive]));
}
