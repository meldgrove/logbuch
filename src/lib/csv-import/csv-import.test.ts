import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CsvError, parseCsv, parseCsvRecords } from "./csv";
import { DEFAULT_RATIONALE, mapRow, parseDate, type MappingContext } from "./mapping";

describe("the CSV reader", () => {
  it("reads quoted fields with commas, doubled quotes, and line breaks, with CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi""\r\nnext line"\r\n\r\n')).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'say "hi"\r\nnext line'],
    ]);
  });

  it("takes semicolons as the delimiter when the header uses them (German Excel)", () => {
    expect(parseCsv("id;title\n1;A, B\n")).toEqual([
      ["id", "title"],
      ["1", "A, B"],
    ]);
  });

  it("rejects stray quotes instead of changing the text", () => {
    expect(() => parseCsv('id,title\n1,"A"B,2024-01-01')).toThrow(/Line 2: text after a closing quote/);
    expect(() => parseCsv('id,title\n1,say "hi"')).toThrow(/Line 2: a quote inside an unquoted field/);
    expect(parseCsv('id,title\n1,"A"\n')).toEqual([["id", "title"], ["1", "A"]]);
  });

  it("rejects a column that appears twice, and ignores columns without a name", () => {
    expect(() => parseCsvRecords("id,decision_text,Decision_Text \n1,Keep this,\n")).toThrow(/decision_text more than once/);
    expect(parseCsvRecords("id,title,,\n1,A,,\n").records).toEqual([{ id: "1", title: "A" }]);
  });

  it("keys rows by trimmed, lower-case header names, and rejects broken files", () => {
    expect(parseCsvRecords(" ID ,Title\n1,  A  \n").records).toEqual([{ id: "1", title: "A" }]);
    expect(() => parseCsvRecords("")).toThrow(CsvError);
    expect(() => parseCsvRecords('id,title\n1,"open')).toThrow(/never ends/);
    expect(() => parseCsvRecords("id,title\n1,A,extra")).toThrow(/Row 2 has 3 fields/);
  });
});

const TEAM = { id: "0196f1e2-0000-7000-8000-00000000000a", name: "Engineering" };
const OPS = { id: "0196f1e2-0000-7000-8000-00000000000b", name: "Operations" };
const DAN = { id: "0196f1e2-0000-7000-8000-0000000000d1", name: "Dan Decider" };
const ADA = { id: "0196f1e2-0000-7000-8000-0000000000a1", name: "Ada Author" };
const SECURITY = { id: "0196f1e2-0000-7000-8000-0000000000e1", name: "IT Security" };
const TOOLS = { id: "0196f1e2-0000-7000-8000-0000000000e2", name: "Workspace Tooling" };
const ctx: MappingContext = {
  today: "2026-11-05",
  defaultTeam: TEAM,
  teamsByName: new Map([
    ["engineering", TEAM],
    ["operations", OPS],
  ]),
  tagsByName: new Map([
    ["it security", SECURITY],
    ["workspace tooling", TOOLS],
  ]),
  peopleByEmail: new Map([
    ["dan@example.org", DAN],
    ["ada@example.org", ADA],
  ]),
};

describe("a CSV row as a logged decision", () => {
  it("maps every column", () => {
    const mapped = mapRow(
      {
        id: "OLD-1",
        title: "Lead stages",
        decided_on: "30.04.2024",
        decider_email: "Dan@Example.org",
        decision_text: "We use three lead stages:\n- MQL\n- SQL",
        summary: "",
        rationale: "Sales and marketing need the same stages.",
        how_decided: "Role decision",
        involved_emails: "ada@example.org; dan@example.org, gone@example.org",
        links: "https://example.org/a https://example.org/b",
        team: "operations",
        impact: "Large",
        reversibility: "one-way",
      },
      ctx,
    );
    expect(mapped).toMatchObject({
      ok: true,
      teamName: "Operations",
      input: {
        title: "Lead stages",
        teamId: OPS.id,
        decidedOn: "2024-04-30",
        deciderId: DAN.id,
        involvedIds: [ADA.id],
        howDecided: "role_decision",
        impact: "large",
        reversibility: "one_way",
        summary: "We use three lead stages: MQL SQL",
        links: ["https://example.org/a", "https://example.org/b"],
      },
      notes: ["gone@example.org has no Logbuch access and is not listed as involved."],
    });
  });

  it("fills sensible defaults for optional columns", () => {
    const mapped = mapRow({ id: "2", title: "Use one tool", decided_on: "2024-05-01", decider_email: "dan@example.org" }, ctx);
    expect(mapped).toMatchObject({
      ok: true,
      teamName: TEAM.name,
      input: {
        type: "decision",
        decisionText: "Use one tool",
        summary: "Use one tool",
        rationale: DEFAULT_RATIONALE,
        howDecided: "other",
        impact: null,
        reversibility: null,
        links: [],
        involvedIds: [],
      },
    });
  });

  it("explains what keeps a row from being imported", () => {
    const base = { id: "3", title: "T", decided_on: "2024-05-01", decider_email: "dan@example.org" };
    const problem = (row: Record<string, string>, extra: Partial<MappingContext> = {}) => {
      const mapped = mapRow(row, { ...ctx, ...extra });
      return mapped.ok ? undefined : mapped.problem;
    };
    expect(problem({ ...base, title: "" })).toBe("The title is empty.");
    expect(problem({ ...base, decided_on: "31.02.2024" })).toMatch(/not a date/);
    expect(problem({ ...base, decided_on: "2026-11-06" })).toBe("decided_on 2026-11-06 lies in the future.");
    expect(problem({ ...base, how_decided: "vote" })).toMatch(/not one of/);
    expect(problem({ ...base, impact: "huge" })).toBe('"huge" in impact is not one of: small, medium, large.');
    expect(problem({ ...base, reversibility: "maybe" })).toBe('"maybe" in reversibility is not one of: two_way, one_way.');
    expect(problem({ ...base, team: "Archive" })).toBe('There is no active team "Archive".');
    expect(problem({ ...base, decider_email: "gone@example.org" })).toMatch(/has no Logbuch access/);
    expect(problem({ ...base, links: "not-a-url" })).toMatch(/http\(s\)/);
    expect(problem({ ...base, decider_email: "gone@example.org" }, { fallbackDecider: ADA })).toBeUndefined();
  });

  it("take the summary from the decision text, keeping numbers that are content", () => {
    const summary = (decision_text: string) => {
      const mapped = mapRow({ id: "x", title: "T", decided_on: "2024-01-01", decider_email: "dan@example.org", decision_text }, ctx);
      return mapped.ok ? mapped.input.summary : undefined;
    };
    expect(summary("2024 budget is approved.")).toBe("2024 budget is approved.");
    expect(summary("-10% is the new discount.")).toBe("-10% is the new discount.");
    expect(summary("## Decision\n\n1. Use one tool\n- [x] done")).toBe("Decision");
    expect(summary("1. Use one tool\n2. Retire the other")).toBe("Use one tool Retire the other");
  });

  it("read the old name of the integrative process, and keys or labels in any case", () => {
    const howDecided = (how_decided: string) => {
      const mapped = mapRow({ id: "x", title: "T", decided_on: "2024-01-01", decider_email: "dan@example.org", how_decided }, ctx);
      return mapped.ok && mapped.input.type === "decision" ? mapped.input.howDecided : undefined;
    };
    expect(howDecided("integrative_meeting")).toBe("integrative_process");
    expect(howDecided("Integrative process in a meeting")).toBe("integrative_process");
    expect(howDecided("INTEGRATIVE DECISION PROCESS")).toBe("integrative_process");
    expect(howDecided("management-decision")).toBe("management_decision");
  });

  it("read dates as YYYY-MM-DD or DD.MM.YYYY, and nothing else", () => {
    expect(parseDate("2024-04-30")).toBe("2024-04-30");
    expect(parseDate("1.5.2024")).toBe("2024-05-01");
    expect(parseDate("04/30/2024")).toBeNull();
    expect(parseDate("2024-13-01")).toBeNull();
  });

  it("maps the context, the reason for one-way, the effective date, tags, and affected teams", () => {
    const mapped = mapRow(
      {
        id: "OLD-4",
        title: "Password manager",
        date: "2026-09-21",
        decider_email: "dan@example.org",
        details: "We tested two tools.",
        reversibility: "one_way",
        why_one_way: "All credentials move.",
        effective_date: "21.09.2026",
        tags: "IT Security; workspace tooling",
        affected_teams: "Operations, Engineering",
        related: "OLD-1 OLD-2,OLD-1",
      },
      ctx,
    );
    expect(mapped).toMatchObject({
      ok: true,
      date: "2026-09-21",
      related: ["OLD-1", "OLD-2"],
      tagNames: ["IT Security", "Workspace Tooling"],
      affectedTeamNames: ["Operations", "Engineering"],
      input: {
        type: "decision",
        decidedOn: "2026-09-21",
        body: "We tested two tools.",
        reversibility: "one_way",
        reversibilityReason: "All credentials move.",
        effectiveDate: "2026-09-21",
        tagIds: [SECURITY.id, TOOLS.id],
        affectedTeamIds: [OPS.id, TEAM.id],
        relatedIds: [],
      },
    });
  });
});

describe("a CSV row as an update or a learning", () => {
  it("maps the type, details, rationale, and the date", () => {
    const mapped = mapRow(
      {
        id: "U-1",
        type: "Update",
        title: "Single sign-on",
        date: "24.07.2026",
        details: "## Login\n\nOne sign-in for **our** tools.\n\nMore later.",
        rationale: "Fewer passwords.",
        impact: "large",
        tags: "IT Security",
        related: "OLD-1",
        links: "https://example.org/login",
      },
      ctx,
    );
    expect(mapped).toMatchObject({
      ok: true,
      date: "2026-07-24",
      related: ["OLD-1"],
      teamName: TEAM.name,
      input: {
        type: "update",
        title: "Single sign-on",
        summary: "Login",
        body: "## Login\n\nOne sign-in for **our** tools.\n\nMore later.",
        rationale: "Fewer passwords.",
        impact: "large",
        tagIds: [SECURITY.id],
        links: ["https://example.org/login"],
      },
    });
    const learning = mapRow({ id: "L-1", type: "learning", title: "Retro", date: "2026-01-01", summary: "Short sprints work." }, ctx);
    expect(learning).toMatchObject({ ok: true, input: { type: "learning", summary: "Short sprints work.", body: "", rationale: "", impact: null } });
  });

  it("explains what keeps a row from being imported", () => {
    const base = { id: "U-2", type: "update", title: "T", date: "2026-01-01" };
    const problem = (row: Record<string, string>) => {
      const mapped = mapRow(row, ctx);
      return mapped.ok ? undefined : mapped.problem;
    };
    expect(problem({ ...base, decider_email: "dan@example.org", how_decided: "other" })).toBe("how_decided, decider_email are only for decisions.");
    expect(problem({ ...base, type: "memo" })).toBe('"memo" in type is not one of: update, decision, learning.');
    expect(problem({ ...base, date: "" })).toMatch(/"" in date is not a date/);
    expect(problem({ ...base, tags: "AI" })).toBe('There is no active tag "AI".');
    expect(problem({ ...base, affected_teams: "Archive" })).toBe('There is no active team "Archive" in affected_teams.');
    expect(problem({ ...base, related: "U-2" })).toBe("An entry cannot be related to itself.");
    expect(problem({ ...base, type: "decision", decider_email: "dan@example.org", why_one_way: "Because." })).toBe(
      "why_one_way is only for one-way decisions.",
    );
    expect(problem({ ...base, type: "decision", decider_email: "dan@example.org", effective_date: "soon" })).toMatch(/in effective_date is not a date/);
  });
});

describe("the template file in docs/", () => {
  it("is accepted", () => {
    const { records } = parseCsvRecords(readFileSync("docs/entry-import-template.csv", "utf8"));
    expect(records).toHaveLength(2);
    expect(mapRow(records[0]!, { ...ctx, fallbackDecider: DAN })).toMatchObject({
      ok: true,
      input: { type: "decision", howDecided: "role_decision", decidedOn: "2024-04-30", impact: "medium", reversibility: "two_way", effectiveDate: "2024-05-03" },
    });
    expect(mapRow(records[1]!, ctx)).toMatchObject({ ok: true, date: "2024-05-30", related: ["OLD-1"], input: { type: "update", impact: "small" } });
  });
});
