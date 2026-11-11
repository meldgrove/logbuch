import type { Metadata } from "next";
import { logEntryAction } from "@/app/(app)/entry-actions";
import { LogForm } from "@/components/entries/log-form";
import { NoTeamsNotice } from "@/components/entries/no-teams-notice";
import { PageHeader } from "@/components/page-header";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getDirectory } from "@/lib/directory/directory";
import { ENTRY_TYPES } from "@/lib/entries/constants";
import { getFormOptions } from "@/lib/entries/queries";
import { serverDate } from "@/lib/format";

export const metadata: Metadata = { title: "Log something" };

/** Log an update, a decision made outside Logbuch, or a learning. */
export default async function LogPage({ searchParams }: PageProps<"/new/log">) {
  const { person } = await requireUser();
  const requested = (await searchParams).type;
  const type = ENTRY_TYPES.find((t) => t === requested);
  const options = await getFormOptions(getDb());
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Log something"
        description="Published right away. Updates and learnings can be corrected later; a decision is not edited, corrections are added as addenda."
      />
      {options.teams.length === 0 ? (
        <NoTeamsNotice isAdmin={person.isAdmin} editable={getDirectory().editable} />
      ) : (
        <LogForm
          action={logEntryAction}
          options={options}
          types={[...ENTRY_TYPES]}
          today={serverDate()}
          defaults={{ type, teamId: person.teamId ?? undefined, deciderId: person.id }}
        />
      )}
    </div>
  );
}
