import { ListFilter, X } from "lucide-react";
import Link from "next/link";
import { SearchForm } from "@/components/form/search-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getFormatter } from "@/lib/auth/session";
import type { TimelineFilters } from "@/lib/entries/queries";
import { activeFilters, choiceFilters, timelineHref, type FilterOptions } from "@/lib/entries/timeline-filters";

interface TimelineFilterProps {
  filters: TimelineFilters;
  options: FilterOptions;
}

/**
 * The "Filters" button with every filter in a popover. The form submits with
 * GET, so each result is a plain URL, and it keeps the search from the
 * sidebar. Render it with `key={timelineHref(filters)}`, so its fields follow
 * the URL.
 */
export function TimelineFilterMenu({ filters, options }: TimelineFilterProps) {
  const count = activeFilters(filters, options).filter((filter) => filter.key !== "q").length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <ListFilter aria-hidden="true" />
          Filters
          {count > 0 ? (
            <Badge variant="secondary" className="rounded-sm px-1.5 font-normal tabular-nums">
              {count}
              <span className="sr-only"> active</span>
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-(--radix-popover-content-available-height) w-[min(34rem,calc(100vw-2rem))] overflow-y-auto">
        <SearchForm action="/" aria-label="Filter entries" className="flex flex-col gap-4">
          {filters.q ? <input type="hidden" name="q" value={filters.q} /> : null}
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            {choiceFilters(options).map((filter) => (
              <Field key={filter.key} className="gap-1.5">
                <FieldLabel htmlFor={`filter-${filter.key}`}>{filter.label}</FieldLabel>
                <NativeSelect id={`filter-${filter.key}`} name={filter.key} size="sm" defaultValue={filters[filter.key] ?? ""} wrapperClassName="w-full">
                  <NativeSelectOption value="">All</NativeSelectOption>
                  {filter.options.map((option) => (
                    <NativeSelectOption key={option.id} value={option.id}>
                      {option.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ))}
            {/* The date range on a row of its own. */}
            <div className="grid grid-cols-2 gap-3 sm:col-span-2">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="filter-from">From</FieldLabel>
                <Input id="filter-from" name="from" type="date" className="h-8" defaultValue={filters.from} />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="filter-to">To</FieldLabel>
                <Input id="filter-to" name="to" type="date" className="h-8" defaultValue={filters.to} />
              </Field>
            </div>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            {count > 0 ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={timelineHref({ q: filters.q })}>Clear filters</Link>
              </Button>
            ) : null}
            <Button type="submit" size="sm">
              Apply filters
            </Button>
          </div>
        </SearchForm>
      </PopoverContent>
    </Popover>
  );
}

/** The search and the filters in use, as chips that remove themselves. Nothing when there are none. */
export async function ActiveFilterList({ filters, options }: TimelineFilterProps) {
  const fmt = await getFormatter();
  const active = activeFilters(filters, options, fmt.date);
  if (active.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ul aria-label="Active filters" className="flex flex-wrap gap-1.5">
        {active.map((filter) => (
          <li key={filter.key}>
            <Badge asChild variant="secondary" className="h-6 max-w-72 gap-1 pr-1.5 font-normal">
              <Link href={filter.removeHref} aria-label={`Remove filter ${filter.label}`}>
                <span className="truncate">{filter.label}</span>
                <X aria-hidden="true" />
              </Link>
            </Badge>
          </li>
        ))}
      </ul>
      {active.length > 1 ? (
        <Button asChild variant="ghost" size="sm" className="h-6 px-2 text-xs">
          <Link href="/">Clear all</Link>
        </Button>
      ) : null}
    </div>
  );
}
