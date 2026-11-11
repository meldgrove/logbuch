import { serverDate } from "@/lib/format";

/*
 * Working days for deadlines: Monday to Friday. Dates are calendar days
 * written as YYYY-MM-DD. A deadline ends at 23:59 on its date in the server's
 * time zone.
 */

function toUtcNoon(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function plusDays(date: string, days: number): string {
  const value = toUtcNoon(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function isWorkingDay(date: string): boolean {
  const weekday = toUtcNoon(date).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/** The date `days` working days after `date`; `date` itself does not count. */
export function addWorkingDays(date: string, days: number): string {
  let current = date;
  let remaining = days;
  while (remaining > 0) {
    current = plusDays(current, 1);
    if (isWorkingDay(current)) remaining -= 1;
  }
  return current;
}

/** The last working day before `date`. */
export function previousWorkingDay(date: string): string {
  let current = plusDays(date, -1);
  while (!isWorkingDay(current)) current = plusDays(current, -1);
  return current;
}

/** Working days after `from` up to and including `to`; 0 when `to` is not later. */
export function workingDaysBetween(from: string, to: string): number {
  let count = 0;
  for (let current = plusDays(from, 1); current <= to; current = plusDays(current, 1)) {
    if (isWorkingDay(current)) count += 1;
  }
  return count;
}

/** True once the deadline day has ended in the server's time zone. */
export function isDeadlinePassed(deadline: string, now: Date = new Date()): boolean {
  return serverDate(now) > deadline;
}

/** Today's date (YYYY-MM-DD) in the server's time zone. */
export const today = serverDate;
