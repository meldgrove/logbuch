import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser, type CurrentUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { EntryError, type Actor } from "@/lib/entries/commands";
import { fieldErrorsOf, formDataToObject } from "@/lib/entries/schemas";
import type { FormState } from "@/lib/form-state";
import { consumeRateLimit, RateLimitError, WRITE_LIMIT } from "@/lib/rate-limit";

/*
 * The shared flow of every form Server Action. Not a "use server" module, so
 * these helpers are never exposed as actions themselves.
 */

/*
 * Values a page binds to a Server Action (`action.bind(null, entry.id)`)
 * arrive as the client sends them: anyone signed in can call an action with
 * other values. Actions check them like form fields.
 */
const id = z.uuid();
export const boundValues = {
  id: z.tuple([id]),
  /** An ID, or null for something new. */
  optionalId: z.tuple([id.nullable()]),
  /** An ID and a flag, such as a person and whether they get access. */
  idAndFlag: z.tuple([id, z.boolean()]),
  /** An entry's ID and number. */
  entry: z.tuple([id, z.number().int().positive()]),
};

/** Pages never bind values that fail the check; only a stale or forged call sends them. */
export const INVALID_BOUND_VALUES: FormState = { formError: "This form is out of date. Reload the page and try again." };

export function actorOf(user: CurrentUser): Actor {
  return { personId: user.person.id, isAdmin: user.person.isAdmin };
}

/**
 * Checks access, validates (the bound values, checked with `boundValues`, and
 * the form), counts the write against the person's limit, writes, then
 * revalidates and redirects to the returned path. Validation, permission, and
 * rate-limit errors come back as form state.
 */
export async function handleFormAction<S extends z.ZodType>(
  formData: FormData,
  schema: S,
  write: (actor: Actor, input: z.infer<S>) => Promise<string>,
  bound: { success: boolean } = { success: true },
): Promise<FormState> {
  const user = await requireUser();
  if (!bound.success) return INVALID_BOUND_VALUES;
  const parsed = schema.safeParse(formDataToObject(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };

  let path: string;
  try {
    await consumeRateLimit(getDb(), `write:${user.person.id}`, WRITE_LIMIT);
    path = await write(actorOf(user), parsed.data);
  } catch (error) {
    if (error instanceof EntryError) {
      const hasFieldErrors = Object.keys(error.fieldErrors).length > 0;
      return { fieldErrors: error.fieldErrors, formError: hasFieldErrors ? undefined : error.message };
    }
    if (error instanceof RateLimitError) return { formError: error.message };
    throw error;
  }
  // The target may be the page the form is on: render it fresh.
  revalidatePath(path.split("#")[0] ?? path);
  redirect(path);
}
