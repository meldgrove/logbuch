import { describe, expect, it } from "vitest";
import { createDateFormatter, dateToken, DEADLINE_END, renderDateTokens, serverDate, serverHour } from "./format";
import { displayPreferences, isTimeZone, type DateFormat } from "./preferences";

// Tests run with TZ=Europe/Amsterdam (vitest.config.ts).
const AFTERNOON = new Date("2026-12-31T13:30:00Z"); // 14:30 in Amsterdam

describe("createDateFormatter", () => {
  it("writes dates as DD.MM.YYYY with a 24-hour clock by default", () => {
    const fmt = createDateFormatter();
    expect(fmt.date("2026-12-31")).toBe("31.12.2026");
    expect(fmt.dateTime(AFTERNOON)).toBe("31.12.2026, 14:30");
    expect(fmt.longDate("2026-11-06")).toBe("Friday, 06.11.2026");
    expect(fmt.month("2026-11")).toBe("Nov 2026");
    expect(fmt.date(null)).toBe("—");
    expect(fmt.dateTime(undefined)).toBe("—");
  });

  it("writes every date format", () => {
    const at = (dateFormat: DateFormat) => createDateFormatter({ dateFormat }).dateTime(AFTERNOON);
    expect(at("YYYY-MM-DD")).toBe("2026-12-31 14:30");
    expect(at("DD/MM/YYYY")).toBe("31/12/2026, 14:30");
    expect(at("MM/DD/YYYY")).toBe("12/31/2026, 2:30 PM");
    expect(createDateFormatter({ dateFormat: "MM/DD/YYYY" }).dateTime(new Date("2026-12-31T23:05:00Z"))).toBe("01/01/2027, 12:05 AM");
  });

  it("shows instants in the reader's time zone, and calendar dates as they are", () => {
    const fmt = createDateFormatter({ timeZone: "America/New_York" });
    expect(fmt.dateTime(AFTERNOON)).toBe("31.12.2026, 08:30");
    expect(fmt.date("2026-12-31")).toBe("31.12.2026");
    expect(createDateFormatter({ timeZone: "Pacific/Kiritimati" }).dateTime(AFTERNOON)).toBe("01.01.2027, 03:30");
  });

  it("shows only the original date of an imported entry, in the server's time zone", () => {
    const fmt = createDateFormatter({ timeZone: "America/Los_Angeles" });
    expect(fmt.published(new Date("2026-07-24T10:00:00Z"), true)).toBe("24.07.2026 · imported");
    expect(fmt.published(new Date("2026-07-24T10:00:00Z"), false)).toBe("24.07.2026, 03:00");
  });
});

describe("server clock", () => {
  it("gives the date and hour in the server's time zone", () => {
    expect(serverDate(new Date("2026-11-09T22:59:00Z"))).toBe("2026-11-09");
    expect(serverDate(new Date("2026-11-09T23:00:00Z"))).toBe("2026-11-10");
    expect(serverHour(new Date("2026-07-01T07:00:00Z"))).toBe(9);
    expect(DEADLINE_END).toBe("23:59 (Europe/Amsterdam)");
  });
});

describe("date tokens", () => {
  it("are written for each reader", () => {
    const text = `Since ${dateToken("2026-11-04")}, and until ${dateToken("2026-11-06")}.`;
    expect(renderDateTokens(text, createDateFormatter())).toBe("Since Wednesday, 04.11.2026, and until Friday, 06.11.2026.");
    expect(renderDateTokens(text, createDateFormatter({ dateFormat: "YYYY-MM-DD" }))).toBe(
      "Since Wednesday, 2026-11-04, and until Friday, 2026-11-06.",
    );
  });
});

describe("displayPreferences", () => {
  it("falls back to the server's time zone and DD.MM.YYYY", () => {
    expect(displayPreferences(null)).toEqual({ timeZone: "Europe/Amsterdam", dateFormat: "DD.MM.YYYY" });
    expect(displayPreferences({ timeZone: "Asia/Tokyo", dateFormat: "YYYY-MM-DD" })).toEqual({ timeZone: "Asia/Tokyo", dateFormat: "YYYY-MM-DD" });
    expect(displayPreferences({ timeZone: "Nowhere/City", dateFormat: "DD-MM" })).toEqual({ timeZone: "Europe/Amsterdam", dateFormat: "DD.MM.YYYY" });
  });

  it("knows real time zones only", () => {
    expect(isTimeZone("Europe/Vienna")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});
