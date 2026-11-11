import { DEFAULT_DATE_FORMAT, SERVER_TIME_ZONE, type DateFormat, type DisplayPreferences } from "@/lib/preferences";

/*
 * Dates and times. Two clocks are involved:
 *
 * - The server's time zone defines calendar days for deadlines, working days,
 *   reminders, and statistics (`serverDate`, `serverHour`, `serverDateTime`).
 * - Each person sees dates and times in their own time zone and date format
 *   (`createDateFormatter`).
 */

export { SERVER_TIME_ZONE };

/** Shortens text to `max` characters, ending with "…" when cut. */
export function clipText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

const partFormats = new Map<string, Intl.DateTimeFormat>();

/** Calendar and clock parts of an instant in a time zone. */
function partsIn(at: Date, timeZone: string) {
  let format = partFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    partFormats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: Number(parts.hour),
    minute: parts.minute!,
  };
}

/** The calendar date (YYYY-MM-DD) of an instant in the server's time zone. */
export function serverDate(now: Date = new Date()): string {
  const p = partsIn(now, SERVER_TIME_ZONE);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The hour (0–23) of an instant in the server's time zone. */
export function serverHour(now: Date = new Date()): number {
  return partsIn(now, SERVER_TIME_ZONE).hour;
}

/** Minutes a time zone is ahead of UTC at an instant. */
function offsetMinutes(at: Date, timeZone: string): number {
  const p = partsIn(at, timeZone);
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), p.hour, Number(p.minute));
  return Math.round((local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** The instant of a wall-clock hour on a date in a time zone, e.g. Monday 09:00 (DST-aware). */
export function zonedDateTime(date: string, hour: number, timeZone: string): Date {
  const asUtc = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const first = new Date(asUtc.getTime() - offsetMinutes(asUtc, timeZone) * 60_000);
  return new Date(asUtc.getTime() - offsetMinutes(first, timeZone) * 60_000);
}

/** The instant of a wall-clock hour on a date in the server's time zone. */
export function serverDateTime(date: string, hour: number): Date {
  return zonedDateTime(date, hour, SERVER_TIME_ZONE);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function writeDate(year: string, month: string, day: string, format: DateFormat): string {
  switch (format) {
    case "YYYY-MM-DD":
      return `${year}-${month}-${day}`;
    case "DD/MM/YYYY":
      return `${day}/${month}/${year}`;
    case "MM/DD/YYYY":
      return `${month}/${day}/${year}`;
    case "DD.MM.YYYY":
      return `${day}.${month}.${year}`;
  }
}

function writeTime(hour: number, minute: string, format: DateFormat): string {
  if (format === "MM/DD/YYYY") {
    const suffix = hour < 12 ? "AM" : "PM";
    return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${suffix}`;
  }
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

export interface DateFormatter {
  readonly timeZone: string;
  readonly dateFormat: DateFormat;
  /** An instant as date and time, e.g. "06.11.2026, 14:30". */
  dateTime(value: Date | null | undefined): string;
  /** A calendar date stored as YYYY-MM-DD, e.g. "06.11.2026". */
  date(value: string | null | undefined): string;
  /** A calendar date with its weekday, e.g. "Friday, 06.11.2026". Used in messages. */
  longDate(value: string): string;
  /** A month written as YYYY-MM, e.g. "Nov 2026". */
  month(value: string): string;
  /** When an entry was published. An imported entry shows only its original date. */
  published(publishedAt: Date | null | undefined, imported: boolean): string;
}

export function createDateFormatter(preferences: Partial<DisplayPreferences> = {}): DateFormatter {
  const timeZone = preferences.timeZone ?? SERVER_TIME_ZONE;
  const dateFormat = preferences.dateFormat ?? DEFAULT_DATE_FORMAT;
  const date = (value: string | null | undefined) => {
    if (!value) return "—";
    const [year, month, day] = value.split("-");
    return writeDate(year!, month!, day!, dateFormat);
  };
  const dateTime = (value: Date | null | undefined) => {
    if (!value) return "—";
    const p = partsIn(value, timeZone);
    const separator = dateFormat === "YYYY-MM-DD" ? " " : ", ";
    return `${writeDate(p.year, p.month, p.day, dateFormat)}${separator}${writeTime(p.hour, p.minute, dateFormat)}`;
  };
  return {
    timeZone,
    dateFormat,
    dateTime,
    date,
    longDate(value) {
      const weekday = WEEKDAYS[new Date(`${value}T12:00:00Z`).getUTCDay()];
      return `${weekday}, ${date(value)}`;
    },
    month(value) {
      const [year, month] = value.split("-");
      return `${MONTHS[Number(month) - 1]} ${year}`;
    },
    published(publishedAt, imported) {
      if (!publishedAt) return "—";
      if (!imported) return dateTime(publishedAt);
      const p = partsIn(publishedAt, SERVER_TIME_ZONE);
      return `${date(`${p.year}-${p.month}-${p.day}`)} · imported`;
    },
  };
}

/** Dates and times for readers without preferences, such as the Slack channel. */
export const defaultFormatter = createDateFormatter();

/** When a deadline day ends, e.g. "23:59 (Europe/Vienna)". Deadlines follow the server's time zone. */
export const DEADLINE_END = `23:59 (${SERVER_TIME_ZONE})`;

/*
 * Messages are planned before anyone reads them, so they carry calendar dates
 * as tokens. The worker writes each token in the recipient's date format.
 */
const DATE_TOKEN = /\[\[date:(\d{4}-\d{2}-\d{2})\]\]/g;

/** A calendar date inside a message text, written later for its reader. */
export function dateToken(date: string): string {
  return `[[date:${date}]]`;
}

/** Writes every date token in `text` with `formatter.longDate`. */
export function renderDateTokens(text: string, formatter: DateFormatter): string {
  return text.replace(DATE_TOKEN, (_, date: string) => formatter.longDate(date));
}
