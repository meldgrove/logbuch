/*
 * The app's navigation: the sidebar items and the breadcrumb of each page.
 * Pure functions of the path, so the client components only render them.
 */

/** Shown above the other items, as the main action. */
export const NEW_ENTRY = { key: "new", href: "/new", label: "New entry" } as const;

export const MAIN_NAV = [
  { key: "timeline", href: "/", label: "Timeline" },
  { key: "tasks", href: "/tasks", label: "My tasks" },
  { key: "stats", href: "/stats", label: "Statistics" },
] as const;

export const ADMIN_NAV = [
  { key: "admin", href: "/admin", label: "Admin" },
  { key: "people", href: "/admin/people", label: "People" },
  { key: "teams", href: "/admin/teams", label: "Teams" },
  { key: "tags", href: "/admin/tags", label: "Tags" },
] as const;

export type NavKey = typeof NEW_ENTRY.key | (typeof MAIN_NAV)[number]["key"] | (typeof ADMIN_NAV)[number]["key"];

/** The sidebar item a page belongs to. Entry pages belong to the timeline. */
export function activeNavKey(pathname: string): NavKey | undefined {
  if (pathname === "/" || pathname.startsWith("/e/")) return "timeline";
  if (pathname === "/tasks") return "tasks";
  if (pathname === "/new" || pathname.startsWith("/new/")) return "new";
  if (pathname === "/stats") return "stats";
  if (pathname === "/admin") return "admin";
  if (pathname === "/admin/people") return "people";
  if (pathname === "/admin/teams") return "teams";
  if (pathname === "/admin/tags") return "tags";
  return undefined;
}

export interface Crumb {
  label: string;
  /** Missing on the current page. */
  href?: string;
}

const NEW_PAGES: Record<string, string> = { log: "Log something", proposal: "New proposal" };
const ENTRY_PAGES: Record<string, string> = { edit: "Edit", history: "History", decide: "Decide" };
const ADMIN_PAGES: Record<string, string> = { people: "People", teams: "Teams", tags: "Tags" };

function entryRef(segment: string): string {
  try {
    return decodeURIComponent(segment).toUpperCase();
  } catch {
    return segment.toUpperCase();
  }
}

/** The breadcrumb shown in the header, from the section to the current page. */
export function breadcrumbsFor(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const [section, child, grandchild] = segments;
  switch (section) {
    case undefined:
      return [{ label: "Timeline" }];
    case "tasks":
      return [{ label: "My tasks" }];
    case "stats":
      return [{ label: "Statistics" }];
    case "new": {
      const page = child ? NEW_PAGES[child] : undefined;
      return page ? [{ label: "New entry", href: "/new" }, { label: page }] : [{ label: "New entry" }];
    }
    case "admin": {
      const page = child ? ADMIN_PAGES[child] : undefined;
      return page ? [{ label: "Admin", href: "/admin" }, { label: page }] : [{ label: "Admin" }];
    }
    case "settings":
      return [{ label: "Settings" }];
    case "e": {
      if (!child) return [{ label: "Timeline", href: "/" }];
      const ref = entryRef(child);
      const page = grandchild ? ENTRY_PAGES[grandchild] : undefined;
      return page
        ? [{ label: "Timeline", href: "/" }, { label: ref, href: `/e/${child}` }, { label: page }]
        : [{ label: "Timeline", href: "/" }, { label: ref }];
    }
    default:
      return [];
  }
}
