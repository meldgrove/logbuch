import { afterEach, describe, expect, it } from "vitest";
import { envValue } from "./env";

describe("envValue", () => {
  afterEach(() => {
    delete process.env.LOGBUCH_TEST_SETTING;
  });

  it("treats unset and blank values as unset", () => {
    expect(envValue("LOGBUCH_TEST_SETTING")).toBeUndefined();
    process.env.LOGBUCH_TEST_SETTING = "  ";
    expect(envValue("LOGBUCH_TEST_SETTING")).toBeUndefined();
  });

  it("returns the trimmed value", () => {
    process.env.LOGBUCH_TEST_SETTING = " /tmp/heartbeat ";
    expect(envValue("LOGBUCH_TEST_SETTING")).toBe("/tmp/heartbeat");
  });
});
