"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/session";
import { getDirectory } from "@/lib/directory/directory";

export interface SyncActionState {
  tone: "success" | "info" | "error";
  message: string;
}

/** Admins can start a directory sync, at most one every 10 seconds. */
export async function syncDirectoryAction(): Promise<SyncActionState> {
  await requireAdmin();
  const sync = getDirectory().sync;
  if (!sync) return { tone: "info", message: "People and teams are managed in Logbuch. There is nothing to sync." };
  const result = await sync.run("admin", 10_000);
  revalidatePath("/admin");
  switch (result.status) {
    case "succeeded":
      return {
        tone: "success",
        message: `Sync finished: ${result.peopleReceived} ${result.peopleReceived === 1 ? "person" : "people"} listed, ${result.accessGranted} gained access, ${result.accessRemoved} lost access.`,
      };
    case "skipped":
      return {
        tone: "info",
        message:
          result.reason === "already_running"
            ? "A sync is running right now. Check the table below in a moment."
            : "A sync ran less than 10 seconds ago. Try again in a moment.",
      };
    case "failed":
      return {
        tone: "error",
        message: `The sync failed: ${result.error}. Logbuch keeps the previous access list.`,
      };
  }
}
