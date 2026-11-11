import type { Metadata } from "next";
import { PreferencesForm } from "@/components/settings/preferences-form";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { DATE_FORMAT_LABELS, DATE_FORMATS, SERVER_TIME_ZONE, timeZoneOptions } from "@/lib/preferences";
import { savePreferencesAction } from "./actions";

export const metadata: Metadata = { title: "Settings" };

/** The signed-in person's own display preferences. */
export default async function SettingsPage() {
  const { person } = await requireUser();
  const fmt = await getFormatter();
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader
        title="Settings"
        description={`How Logbuch shows dates and times to you. Deadlines always end at 23:59 in ${SERVER_TIME_ZONE}, the time zone of this Logbuch.`}
      />
      <Card>
        <CardContent>
          <PreferencesForm
            action={savePreferencesAction}
            timeZone={person.timeZone}
            dateFormat={fmt.dateFormat}
            serverTimeZone={SERVER_TIME_ZONE}
            timeZones={timeZoneOptions()}
            dateFormats={DATE_FORMATS.map((value) => ({ value, label: DATE_FORMAT_LABELS[value] }))}
            example={fmt.dateTime(new Date())}
          />
        </CardContent>
      </Card>
    </div>
  );
}
