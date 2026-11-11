import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { boundValues, handleFormAction, INVALID_BOUND_VALUES } from "./form-actions";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  consumeRateLimit: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect to ${path}`);
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  consumeRateLimit: mocks.consumeRateLimit,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: vi.fn() }));

const ID = "01a1b6c4-fa9a-7e81-be3d-3e1322d1f868";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ userId: "user", person: { id: ID, isAdmin: true } });
});

describe("boundValues", () => {
  it.each([
    ["id", [ID]],
    ["optionalId", [ID]],
    ["optionalId", [null]],
    ["idAndFlag", [ID, false]],
    ["entry", [ID, 12]],
  ] as const)("accepts %s %j", (kind, values) => {
    expect(boundValues[kind].safeParse(values).success).toBe(true);
  });

  it.each([
    ["id", ["7"]],
    ["id", ["'; drop table entry; --"]],
    ["id", []],
    ["optionalId", [undefined]],
    ["idAndFlag", [ID, "false"]],
    ["idAndFlag", [ID, 0]],
    ["idAndFlag", [ID]],
    ["entry", [ID, "12"]],
    ["entry", [ID, 0]],
    ["entry", [ID, 1.5]],
    ["entry", [ID, 12, "extra"]],
  ] as const)("rejects %s %j", (kind, values) => {
    expect(boundValues[kind].safeParse(values).success).toBe(false);
  });
});

describe("handleFormAction", () => {
  const schema = z.object({ name: z.string() });
  const form = () => {
    const data = new FormData();
    data.set("name", "Budget");
    return data;
  };

  it("refuses bound values that fail their check before it writes", async () => {
    const write = vi.fn(async () => "/");
    const state = await handleFormAction(form(), schema, write, boundValues.id.safeParse(["not-an-id"]));
    expect(state).toEqual(INVALID_BOUND_VALUES);
    expect(mocks.requireUser).toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("writes and redirects when the bound values pass", async () => {
    const write = vi.fn(async () => "/admin/tags");
    await expect(handleFormAction(form(), schema, write, boundValues.id.safeParse([ID]))).rejects.toThrow("redirect to /admin/tags");
    expect(write).toHaveBeenCalledWith({ personId: ID, isAdmin: true }, { name: "Budget" });
  });
});

describe("Server Actions with bound values", () => {
  it("refuses a forged flag instead of reading the string \"false\" as true", async () => {
    const { setPersonAccessAction } = await import("@/app/(app)/admin/directory-actions");
    const forged = "false" as unknown as boolean;
    await expect(setPersonAccessAction(ID, forged, {}, new FormData())).resolves.toEqual(INVALID_BOUND_VALUES);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it("refuses an entry ID that is not a UUID instead of failing in the database", async () => {
    const { goAction } = await import("@/app/(app)/proposal-actions");
    await expect(goAction("1 or 1=1", 3, {}, new FormData())).resolves.toEqual(INVALID_BOUND_VALUES);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });
});
