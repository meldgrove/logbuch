import { describe, expect, it } from "vitest";
import { serverDateTime } from "@/lib/format";
import { addWorkingDays, isDeadlinePassed, isWorkingDay, previousWorkingDay, workingDaysBetween } from "./index";

// Tests run with TZ=Europe/Amsterdam (vitest.config.ts): UTC+1 in winter, UTC+2 in summer.

describe("isWorkingDay", () => {
  it("is Monday to Friday", () => {
    expect(isWorkingDay("2026-11-06")).toBe(true); // Friday
    expect(isWorkingDay("2026-11-07")).toBe(false); // Saturday
    expect(isWorkingDay("2026-11-08")).toBe(false); // Sunday
    expect(isWorkingDay("2026-12-25")).toBe(true); // a Friday; there is no holiday calendar
  });
});

describe("addWorkingDays", () => {
  it("skips weekends", () => {
    expect(addWorkingDays("2026-11-06", 1)).toBe("2026-11-09"); // Fri + 1 = Mon
    expect(addWorkingDays("2026-11-04", 2)).toBe("2026-11-06");
    expect(addWorkingDays("2026-11-04", 5)).toBe("2026-11-11");
  });

  it("does not count the start day", () => {
    expect(addWorkingDays("2026-11-07", 1)).toBe("2026-11-09"); // Sat + 1 = Mon
  });
});

describe("previousWorkingDay", () => {
  it("skips weekends", () => {
    expect(previousWorkingDay("2026-11-09")).toBe("2026-11-06"); // Monday → Friday
    expect(previousWorkingDay("2026-11-07")).toBe("2026-11-06"); // Saturday → Friday
    expect(previousWorkingDay("2026-11-04")).toBe("2026-11-03");
  });
});

describe("workingDaysBetween", () => {
  it("counts working days after the start up to the end", () => {
    expect(workingDaysBetween("2026-11-04", "2026-11-11")).toBe(5);
    expect(workingDaysBetween("2026-11-06", "2026-11-09")).toBe(1);
    expect(workingDaysBetween("2026-11-11", "2026-11-04")).toBe(0);
  });
});

describe("isDeadlinePassed", () => {
  it("passes after 23:59 on the deadline date in the server's time zone", () => {
    // Winter (UTC+1): 2026-11-09 23:59 local is 22:59 UTC.
    expect(isDeadlinePassed("2026-11-09", new Date("2026-11-09T22:58:59Z"))).toBe(false);
    expect(isDeadlinePassed("2026-11-09", new Date("2026-11-09T23:00:00Z"))).toBe(true);
    // Summer (UTC+2).
    expect(isDeadlinePassed("2026-07-01", new Date("2026-07-01T21:59:00Z"))).toBe(false);
    expect(isDeadlinePassed("2026-07-01", new Date("2026-07-01T22:00:00Z"))).toBe(true);
  });
});

describe("serverDateTime", () => {
  it("finds a wall-clock hour on both sides of daylight saving time", () => {
    expect(serverDateTime("2026-11-09", 9).toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(serverDateTime("2026-06-08", 9).toISOString()).toBe("2026-06-08T07:00:00.000Z");
    // The switch to summer time on Sunday, 2027-03-28.
    expect(serverDateTime("2027-03-22", 9).toISOString()).toBe("2027-03-22T08:00:00.000Z");
    expect(serverDateTime("2027-03-29", 9).toISOString()).toBe("2027-03-29T07:00:00.000Z");
  });
});
