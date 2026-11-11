"use client";

import { Check, ChevronsUpDown, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface PickerOption {
  id: string;
  label: string;
  hint?: string;
}

interface OptionPickerProps {
  id: string;
  name: string;
  options: PickerOption[];
  multiple?: boolean;
  defaultValue?: string[];
  placeholder: string;
  invalid?: boolean;
  describedBy?: string;
}

/**
 * Searchable select for people, teams, and tags (a shadcn Combobox). Submits
 * one hidden input per selected value.
 */
export function OptionPicker({
  id,
  name,
  options,
  multiple = false,
  defaultValue = [],
  placeholder,
  invalid,
  describedBy,
}: OptionPickerProps) {
  const [selected, setSelected] = useState<string[]>(defaultValue.filter(Boolean));
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);

  function choose(value: string) {
    if (multiple) {
      setSelected((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]));
    } else {
      setSelected([value]);
      setOpen(false);
    }
  }

  const label = multiple
    ? selected.length > 0
      ? `${selected.length} selected`
      : placeholder
    : (byId.get(selected[0] ?? "")?.label ?? placeholder);

  return (
    <div>
      {selected.map((value) => (
        <input key={value} type="hidden" name={name} value={value} />
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
          <Command>
            <CommandInput placeholder="Search…" />
            <CommandList>
              <CommandEmpty>Nothing found.</CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={`${option.label} ${option.hint ?? ""} ${option.id}`}
                    onSelect={() => choose(option.id)}
                  >
                    <Check className={cn(selected.includes(option.id) ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                    <span>{option.label}</span>
                    {option.hint ? <span className="ml-auto text-xs text-muted-foreground">{option.hint}</span> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {multiple && selected.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Selected">
          {selected.map((value) => {
            const optionLabel = byId.get(value)?.label ?? value;
            return (
              <li key={value}>
                <Badge variant="secondary" className="gap-1 pr-1">
                  {optionLabel}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-4 rounded-sm hover:bg-muted-foreground/20"
                    aria-label={`Remove ${optionLabel}`}
                    onClick={() => setSelected((current) => current.filter((v) => v !== value))}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </Badge>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
