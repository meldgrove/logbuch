import { describe, expect, it } from "vitest";
import { activeNavKey, breadcrumbsFor } from "./navigation";

describe("activeNavKey", () => {
  it.each([
    ["/", "timeline"],
    ["/e/LB-12", "timeline"],
    ["/e/LB-12/history", "timeline"],
    ["/tasks", "tasks"],
    ["/new", "new"],
    ["/new/proposal", "new"],
    ["/stats", "stats"],
    ["/admin", "admin"],
    ["/admin/tags", "tags"],
    ["/login", undefined],
    ["/newsletter", undefined],
  ])("%s belongs to %s", (pathname, key) => {
    expect(activeNavKey(pathname)).toBe(key);
  });
});

describe("breadcrumbsFor", () => {
  it.each([
    ["/", [{ label: "Timeline" }]],
    ["/tasks", [{ label: "My tasks" }]],
    ["/stats", [{ label: "Statistics" }]],
    ["/new", [{ label: "New entry" }]],
    ["/new/log", [{ label: "New entry", href: "/new" }, { label: "Log something" }]],
    ["/new/proposal", [{ label: "New entry", href: "/new" }, { label: "New proposal" }]],
    ["/new/update", [{ label: "New entry" }]],
    ["/admin", [{ label: "Admin" }]],
    ["/admin/tags", [{ label: "Admin", href: "/admin" }, { label: "Tags" }]],
    ["/e/lb-12", [{ label: "Timeline", href: "/" }, { label: "LB-12" }]],
    [
      "/e/LB-12/history",
      [{ label: "Timeline", href: "/" }, { label: "LB-12", href: "/e/LB-12" }, { label: "History" }],
    ],
    ["/e/LB-12/decide", [{ label: "Timeline", href: "/" }, { label: "LB-12", href: "/e/LB-12" }, { label: "Decide" }]],
    ["/e/LB-12/edit", [{ label: "Timeline", href: "/" }, { label: "LB-12", href: "/e/LB-12" }, { label: "Edit" }]],
    ["/e/%E0", [{ label: "Timeline", href: "/" }, { label: "%E0" }]],
    ["/unknown", []],
  ])("%s", (pathname, crumbs) => {
    expect(breadcrumbsFor(pathname)).toEqual(crumbs);
  });
});
