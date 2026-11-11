import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import type { Database, Transaction } from "@/lib/db/client";
import { appSetting } from "@/lib/db/schema";
import { DEFAULT_PERIODS, MINIMUM_PERIODS, type Reversibility, type Periods } from "./rules";

const PERIODS_KEY = "default_periods";

const periodsSchema = z.object({
  two_way: z.object({ feedback: z.number().int(), objection: z.number().int() }),
  one_way: z.object({ feedback: z.number().int(), objection: z.number().int() }),
});

export type DefaultPeriods = Record<Reversibility, Periods>;

/** Default periods in working days, as set by admins (never below the minimums). */
export async function getDefaultPeriods(db: Database | Transaction): Promise<DefaultPeriods> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, PERIODS_KEY));
  const parsed = periodsSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_PERIODS;
}

export function periodErrors(periods: DefaultPeriods): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const type of ["two_way", "one_way"] as const) {
    for (const phase of ["feedback", "objection"] as const) {
      const minimum = MINIMUM_PERIODS[type][phase];
      if (periods[type][phase] < minimum || periods[type][phase] > 60) {
        errors[`${type}.${phase}`] = `Between ${minimum} and 60 working days.`;
      }
    }
  }
  return errors;
}

export async function setDefaultPeriods(db: Database, actorId: string, periods: DefaultPeriods): Promise<void> {
  if (Object.keys(periodErrors(periods)).length > 0) throw new Error("Periods below the minimum");
  await db.transaction(async (tx) => {
    const before = await getDefaultPeriods(tx);
    await tx
      .insert(appSetting)
      .values({ key: PERIODS_KEY, value: periods, updatedById: actorId })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: periods, updatedById: actorId, updatedAt: new Date() } });
    await recordAudit(tx, { actorId, action: "settings.periods_changed", payload: { before, after: periods } });
  });
}
