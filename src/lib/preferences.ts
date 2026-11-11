/*
 * Display preferences of a person: the time zone and the date format used to
 * show dates and times. Deadlines and working days do not depend on them; they
 * follow the server's time zone.
 */

export const DATE_FORMATS = ["DD.MM.YYYY", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export const DEFAULT_DATE_FORMAT: DateFormat = "DD.MM.YYYY";

export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  "DD.MM.YYYY": "DD.MM.YYYY (31.12.2026, 14:30)",
  "YYYY-MM-DD": "YYYY-MM-DD (2026-12-31 14:30)",
  "DD/MM/YYYY": "DD/MM/YYYY (31/12/2026, 14:30)",
  "MM/DD/YYYY": "MM/DD/YYYY (12/31/2026, 2:30 PM)",
};

export interface DisplayPreferences {
  timeZone: string;
  dateFormat: DateFormat;
}

/** The time zone of the server process (the `TZ` environment variable, or the system's). */
export const SERVER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function isDateFormat(value: unknown): value is DateFormat {
  return typeof value === "string" && (DATE_FORMATS as readonly string[]).includes(value);
}

/** True for an IANA time zone name the runtime knows, e.g. "Europe/Vienna". */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Every IANA time zone the runtime knows, sorted. */
export function timeZoneOptions(): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

/** A person's preferences, with defaults for what they have not chosen. */
export function displayPreferences(person?: { timeZone: string | null; dateFormat: string | null } | null): DisplayPreferences {
  return {
    timeZone: person?.timeZone && isTimeZone(person.timeZone) ? person.timeZone : SERVER_TIME_ZONE,
    dateFormat: isDateFormat(person?.dateFormat) ? person.dateFormat : DEFAULT_DATE_FORMAT,
  };
}
