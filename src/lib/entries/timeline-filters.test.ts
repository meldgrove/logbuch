import { describe, expect, it } from "vitest";
import { activeFilters, filterParams, timelineHref } from "./timeline-filters";

const TEAM = "0190a7c0-0000-7000-8000-000000000001";
const options = {
  teams: [{ id: TEAM, label: "Engineering" }],
  tags: [],
  people: [],
};

describe("timelineHref", () => {
  it("is the plain timeline without filters", () => {
    expect(timelineHref({})).toBe("/");
  });

  it("keeps the filters in a fixed order and adds later pages", () => {
    expect(timelineHref({ to: "2026-11-01", q: "laptop", type: "decision", page: 3 }, 2)).toBe(
      "/?q=laptop&type=decision&to=2026-11-01&page=2",
    );
  });

  it("drops empty values", () => {
    expect(timelineHref({ q: "", type: undefined })).toBe("/");
  });
});

describe("filterParams", () => {
  it("leaves out the fields a form sets itself", () => {
    expect(filterParams({ q: "laptop", type: "update", page: 2 }, ["q"])).toEqual([["type", "update"]]);
  });
});

describe("activeFilters", () => {
  it("names each filter with its value and links to the timeline without it", () => {
    expect(activeFilters({ q: "laptop", type: "decision", team: TEAM, from: "2026-01-05", page: 4 }, options)).toEqual([
      { key: "q", label: "Search: “laptop”", removeHref: `/?type=decision&team=${TEAM}&from=2026-01-05` },
      { key: "type", label: "Type: Decision", removeHref: `/?q=laptop&team=${TEAM}&from=2026-01-05` },
      { key: "team", label: "Team: Engineering", removeHref: "/?q=laptop&type=decision&from=2026-01-05" },
      { key: "from", label: "From 05.01.2026", removeHref: `/?q=laptop&type=decision&team=${TEAM}` },
    ]);
  });

  it("shows the search alone", () => {
    expect(activeFilters({ q: "laptop" }, options)).toEqual([{ key: "q", label: "Search: “laptop”", removeHref: "/" }]);
  });

  it("is empty without filters", () => {
    expect(activeFilters({ page: 2 }, options)).toEqual([]);
  });

  it("marks a value that is no longer an option", () => {
    expect(activeFilters({ tag: TEAM }, options)[0]?.label).toBe("Tag: Unknown");
  });
});
