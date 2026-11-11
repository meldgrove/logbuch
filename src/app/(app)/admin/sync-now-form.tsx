"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { syncDirectoryAction, type SyncActionState } from "./actions";

export function SyncNowForm() {
  const [state, formAction, pending] = useActionState<SyncActionState | null>(syncDirectoryAction, null);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Syncing…" : "Sync now"}
      </Button>
      <p
        role="status"
        className={cn(
          "text-sm",
          state?.tone === "error" ? "text-destructive" : "text-muted-foreground",
          !state && "sr-only",
        )}
      >
        {state?.message ?? ""}
      </p>
    </form>
  );
}
