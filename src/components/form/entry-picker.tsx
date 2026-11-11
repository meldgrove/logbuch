"use client";

import { Check, ChevronsUpDown, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface EntryOption {
  id: string;
  label: string;
}

interface EntryPickerProps {
  id: string;
  name: string;
  /** "related": any published entry. "supersedes": decisions not replaced yet. */
  mode: "related" | "supersedes";
  multiple?: boolean;
  excludeId?: string;
  defaultValue?: EntryOption[];
  placeholder: string;
  invalid?: boolean;
  describedBy?: string;
}

/** Searches published entries by title, text, or LB number as the user types. */
export function EntryPicker({
  id,
  name,
  mode,
  multiple = false,
  excludeId,
  defaultValue = [],
  placeholder,
  invalid,
  describedBy,
}: EntryPickerProps) {
  const [selected, setSelected] = useState<EntryOption[]>(defaultValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntryOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: query, mode });
        if (excludeId) params.set("exclude", excludeId);
        const response = await fetch(`/api/entries/search?${params}`, { signal: controller.signal });
        if (response.ok) setResults(((await response.json()) as { entries: EntryOption[] }).entries);
      } catch {
        // Aborted or offline: keep the previous results.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, mode, excludeId]);

  function choose(option: EntryOption) {
    if (multiple) {
      setSelected((current) =>
        current.some((s) => s.id === option.id) ? current.filter((s) => s.id !== option.id) : [...current, option],
      );
    } else {
      setSelected((current) => (current[0]?.id === option.id ? [] : [option]));
      setOpen(false);
    }
  }

  const label = multiple
    ? selected.length > 0
      ? `${selected.length} selected`
      : placeholder
    : (selected[0]?.label ?? placeholder);

  return (
    <div>
      {selected.map((option) => (
        <input key={option.id} type="hidden" name={name} value={option.id} />
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className={cn("w-full justify-between font-normal", selected.length === 0 && "text-muted-foreground")}
          >
            <span className="truncate">{label}</span>
            <ChevronsUpDown className="opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search by title or LB number…" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>{loading ? "Searching…" : "Nothing found."}</CommandEmpty>
              <CommandGroup>
                {results.map((option) => (
                  <CommandItem key={option.id} value={option.id} onSelect={() => choose(option)}>
                    <Check
                      className={cn(selected.some((s) => s.id === option.id) ? "opacity-100" : "opacity-0")}
                      aria-hidden="true"
                    />
                    <span className="truncate">{option.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (multiple || selected[0]) ? (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Selected">
          {selected.map((option) => (
            <li key={option.id}>
              <Badge variant="secondary" className="gap-1 pr-1">
                {option.label}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-4 rounded-sm hover:bg-muted-foreground/20"
                  aria-label={`Remove ${option.label}`}
                  onClick={() => setSelected((current) => current.filter((s) => s.id !== option.id))}
                >
                  <X aria-hidden="true" />
                </Button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
