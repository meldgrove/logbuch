import type { Metadata } from "next";
import { saveDraftAction } from "@/app/(app)/proposal-actions";
import { NoTeamsNotice } from "@/components/entries/no-teams-notice";
import { ProposalForm } from "@/components/proposals/proposal-form";
import { PageHeader } from "@/components/page-header";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getDirectory } from "@/lib/directory/directory";
import { getFormOptions } from "@/lib/entries/queries";
import { DEADLINE_END } from "@/lib/format";
import { periodDefaults } from "@/lib/process/form-defaults";

export const metadata: Metadata = { title: "New proposal" };

export default async function NewProposalPage() {
  const { person } = await requireUser();
  const db = getDb();
  const [options, periods] = await Promise.all([getFormOptions(db), periodDefaults(db)]);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="New proposal" description="A question for the decision process. It stays a private draft until you submit it." />
      {options.teams.length === 0 ? (
        <NoTeamsNotice isAdmin={person.isAdmin} editable={getDirectory().editable} />
      ) : (
        <ProposalForm
          action={saveDraftAction.bind(null, null)}
          options={options}
          periodDefaults={periods}
          proposerId={person.id}
          defaults={{ teamId: person.teamId ?? undefined, deciderId: person.id }}
          dateFormat={(await getFormatter()).dateFormat}
          deadlineEnd={DEADLINE_END}
        />
      )}
    </div>
  );
}
