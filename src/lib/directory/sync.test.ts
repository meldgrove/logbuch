import { describe, expect, it } from "vitest";
import { directoryPerson, snapshot } from "../../../tests/fixtures/directory";
import { assertPlausible } from "./sync";

describe("assertPlausible", () => {
  it("rejects a response without people", () => {
    expect(() => assertPlausible(snapshot([]))).toThrow(/no people/);
  });

  it("rejects duplicate people or login subjects", () => {
    expect(() =>
      assertPlausible(snapshot([directoryPerson({ externalId: "p1" }), directoryPerson({ externalId: "p1" })])),
    ).toThrow(/duplicate/);
    expect(() =>
      assertPlausible(
        snapshot([
          directoryPerson({ externalId: "p1", subject: "sub" }),
          directoryPerson({ externalId: "p2", subject: "sub" }),
        ]),
      ),
    ).toThrow(/duplicate/);
  });

  it("rejects a response without teams, since every entry needs one", () => {
    expect(() => assertPlausible(snapshot([directoryPerson({ externalId: "p1" })], []))).toThrow(/no teams/);
  });

  it("accepts a normal response", () => {
    expect(() => assertPlausible(snapshot([directoryPerson({ externalId: "p1" })]))).not.toThrow();
  });
});
