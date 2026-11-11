"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import type { FormState } from "@/app/(app)/entry-actions";

/**
 * Runs a Server Action from a form without React's automatic form reset, so
 * every field keeps what the person entered when the server rejects it.
 * The browser's own validation still runs before submit.
 */
export function useFormAction(action: (state: FormState, formData: FormData) => Promise<FormState>) {
  const [state, dispatch, pending] = useActionState(action, {});
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }
  return { state, onSubmit, pending };
}
