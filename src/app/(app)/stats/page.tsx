import type { Metadata } from "next";
import { MonthlyStatistics } from "@/components/measures/monthly-statistics";
import { PageHeader } from "@/components/page-header";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getMonthlyStatistics } from "@/lib/measures/queries";

export const metadata: Metadata = { title: "Statistics" };

/** Usage statistics, for everyone with access. */
export default async function StatsPage() {
  await requireUser();
  const measures = await getMonthlyStatistics(getDb(), new Date(), 12);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Statistics" description="How the decision process is used, month by month." />
      <MonthlyStatistics measures={measures} />
    </div>
  );
}
