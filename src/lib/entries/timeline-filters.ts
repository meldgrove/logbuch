import { defaultFormatter } from "@/lib/format";
import {
  ENTRY_TYPES,
  HOW_DECIDED,
  HOW_DECIDED_LABELS,
  IMPACT_LABELS,
  IMPACTS,
  REVERSIBILITIES,
  REVERSIBILITY_LABELS,
  TYPE_LABELS,
} from "./constants";
import type { TimelineFilters } from "./queries";

/*
 * The timeline's filters as the page shows them: their labels, the active
 * ones, and the URLs that keep or drop them. Pure, so the page only renders.
 */

export interface FilterOption {
  id: string;
  label: string;
}

export interface FilterOptions {
  teams: FilterOption[];
  tags: FilterOption[];
  people: FilterOption[];
}

export type ChoiceFilterKey = "type" | "status" | "impact" | "reversibility" | "how" | "team" | "affected" | "tag" | "person";
export type FilterKey = "q" | ChoiceFilterKey | "from" | "to";

export interface ChoiceFilter {
  key: ChoiceFilterKey;
  label: string;
  options: FilterOption[];
}

const STATUS_OPTIONS: FilterOption[] = [
  { id: "open", label: "Open proposals" },
  { id: "decided", label: "Decided" },
  { id: "rejected", label: "Rejected" },
  { id: "withdrawn", label: "Withdrawn" },
];

/** The filters with a list of choices, in the order the filter form shows them. */
export function choiceFilters(options: FilterOptions): ChoiceFilter[] {
  return [
    { key: "type", label: "Type", options: ENTRY_TYPES.map((id) => ({ id, label: TYPE_LABELS[id] })) },
    { key: "status", label: "Status", options: STATUS_OPTIONS },
    { key: "impact", label: "Impact", options: IMPACTS.map((id) => ({ id, label: IMPACT_LABELS[id] })) },
    { key: "reversibility", label: "Reversibility", options: REVERSIBILITIES.map((id) => ({ id, label: REVERSIBILITY_LABELS[id] })) },
    { key: "team", label: "Team", options: options.teams },
    { key: "affected", label: "Affected team", options: options.teams },
    { key: "tag", label: "Tag", options: options.tags },
    { key: "person", label: "Person involved", options: options.people },
    { key: "how", label: "How it was decided", options: HOW_DECIDED.map((id) => ({ id, label: HOW_DECIDED_LABELS[id] })) },
  ];
}

/** Every parameter in a fixed order, so equal filters give equal URLs. */
const PARAMS = ["q", "type", "status", "impact", "reversibility", "team", "affected", "tag", "person", "how", "from", "to"] as const;

/** The filters as hidden form fields, without the ones the form itself sets. */
export function filterParams(filters: TimelineFilters, without: readonly (typeof PARAMS)[number][] = []): [string, string][] {
  return PARAMS.filter((key) => !without.includes(key)).flatMap((key) => {
    const value = filters[key];
    return value === undefined || value === "" ? [] : [[key, String(value)] as [string, string]];
  });
}

/** The timeline with these filters, on the given page. */
export function timelineHref(filters: TimelineFilters, page = 1): string {
  const params = new URLSearchParams(filterParams(filters));
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export interface ActiveFilter {
  key: FilterKey;
  label: string;
  /** The timeline without this filter, on its first page. */
  removeHref: string;
}

/**
 * The filters in use, each with a link that removes it. The search from the
 * sidebar comes first; the filters form does not set it.
 */
export function activeFilters(
  filters: TimelineFilters,
  options: FilterOptions,
  formatDate: (date: string) => string = defaultFormatter.date,
): ActiveFilter[] {
  const without = (key: FilterKey) => timelineHref({ ...filters, [key]: undefined });
  const active: ActiveFilter[] = [];
  if (filters.q) active.push({ key: "q", label: `Search: “${filters.q}”`, removeHref: without("q") });
  for (const filter of choiceFilters(options)) {
    const value = filters[filter.key];
    if (!value) continue;
    const option = filter.options.find((o) => o.id === value);
    active.push({ key: filter.key, label: `${filter.label}: ${option?.label ?? "Unknown"}`, removeHref: without(filter.key) });
  }
  if (filters.from) active.push({ key: "from", label: `From ${formatDate(filters.from)}`, removeHref: without("from") });
  if (filters.to) active.push({ key: "to", label: `Until ${formatDate(filters.to)}`, removeHref: without("to") });
  return active;
}
