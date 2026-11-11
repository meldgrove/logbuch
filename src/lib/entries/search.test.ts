import { describe, expect, it } from "vitest";
import { searchTsQuery } from "./search";

describe("searchTsQuery", () => {
  it("requires every word and lets the last one be the start of a word", () => {
    expect(searchTsQuery("laptop budg")).toBe("'laptop' & 'budg':*");
    expect(searchTsQuery("  Entscheidung ")).toBe("'Entscheidung':*");
  });

  it("keeps hosts, email addresses, and numbers whole, as the text index does", () => {
    expect(searchTsQuery("example.org")).toBe("'example.org':*");
    expect(searchTsQuery("foo@example.org 1.600")).toBe("'foo@example.org' & '1.600':*");
    expect(searchTsQuery("LB-12")).toBe("'LB-12':*");
  });

  it("quotes every word, so operators cannot change the query", () => {
    expect(searchTsQuery(`budget' | !(x) <-> "y":* a\\b`)).toBe(`'budget' & '!(x)' & '"y":*' & 'a' & 'b':*`);
  });

  it("drops NUL, which PostgreSQL rejects in text", () => {
    expect(searchTsQuery("check\u0000list")).toBe("'check' & 'list':*");
  });

  it("has no query without letters or digits", () => {
    expect(searchTsQuery("")).toBeUndefined();
    expect(searchTsQuery(" -!& '' ")).toBeUndefined();
  });

  it("uses at most 20 words", () => {
    expect(searchTsQuery(Array.from({ length: 30 }, (_, i) => `w${i}`).join(" "))).toBe(
      `${Array.from({ length: 19 }, (_, i) => `'w${i}'`).join(" & ")} & 'w19':*`,
    );
  });
});
