"use client";

import { ArrowDown, ArrowUp, CornerDownLeft, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import type { SearchResult } from "@/lib/entries/search";
import { timelineHref } from "@/lib/entries/timeline-filters";
import { cn } from "@/lib/utils";

const noSubscription = () => () => {};

/** "⌘K" on Apple devices, "Ctrl K" elsewhere; null on the server, which cannot tell. */
function useShortcutLabel(): string | null {
  return useSyncExternalStore(
    noSubscription,
    () => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl K"),
    () => null,
  );
}

/** Opens the search; it looks like a search field at the top of the sidebar. */
export function SearchButton({ onClick }: { onClick: () => void }) {
  const shortcut = useShortcutLabel();
  return (
    <SidebarMenuButton
      tooltip={shortcut ? `Search entries (${shortcut})` : "Search entries"}
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K /"
      onClick={onClick}
      className="border bg-background text-muted-foreground shadow-xs"
    >
      <Search aria-hidden="true" />
      {/* The visible text is the name: the key below is hidden from screen readers. */}
      <span>Search entries</span>
      {shortcut ? (
        <Kbd aria-hidden="true" className="ml-auto group-data-[collapsible=icon]:hidden">
          {shortcut}
        </Kbd>
      ) : null}
    </SidebarMenuButton>
  );
}

/** Whether a key opens the search: ⌘K or Ctrl+K anywhere, "/" outside a field. */
function opensSearch(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey) return false;
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "k") return true;
  // Shift is allowed: on a German keyboard "/" is Shift+7.
  if (event.key !== "/" || event.metaKey || event.ctrlKey) return false;
  const target = event.target;
  return !(target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select")));
}

/**
 * The search for entries, nothing else. ⌘K, Ctrl+K, or "/" open it on every
 * page. Results come while typing; Enter opens the selected entry, and
 * "View all results" shows the search in the timeline.
 */
export function EntrySearch({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!opensSearch(event)) return;
      // Leave another open dialog, such as the filters, alone.
      if (!open && document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
      event.preventDefault();
      onOpenChange(true);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  function go(href: string) {
    onOpenChange(false);
    router.push(href);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Near the top, so the field stays put while the results change. */}
      <DialogContent showCloseButton={false} className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="sr-only">
          <DialogTitle>Search entries</DialogTitle>
          <DialogDescription>Find updates, decisions, and learnings by title, text, or a number like LB-12.</DialogDescription>
        </DialogHeader>
        <SearchPanel onGo={go} />
        <DialogClose asChild>
          <Button variant="ghost" size="sm" className="absolute top-2.5 right-3 h-7 px-1.5">
            <Kbd aria-hidden="true">Esc</Kbd>
            <span className="sr-only">Close search</span>
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/** The field, the results, and the footer. It unmounts with the dialog, so every search starts empty. */
function SearchPanel({ onGo }: { onGo: (href: string) => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ term: string; results: SearchResult[] | null }>();
  const term = query.trim();
  // One digit is enough for a number like LB-7.
  const ready = term.length >= 2 || /^\d$/.test(term);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?${new URLSearchParams({ q: term })}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`The search answered ${response.status}.`);
        const { results } = (await response.json()) as { results: SearchResult[] };
        setFound({ term, results });
      } catch {
        if (!controller.signal.aborted) setFound({ term, results: null });
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, ready]);

  // Only results for what is in the field now, so Enter never opens an older match.
  const results = ready && found?.term === term ? found.results : undefined;
  const viewAll = () => onGo(timelineHref({ q: term }));
  const message = !term
    ? "Search by title, text, or a number like LB-12."
    : !ready
      ? "Type at least two characters."
      : results === undefined
        ? "Searching…"
        : results === null
          ? "The search is not available right now. Try again."
          : results.length === 0
            ? "No entries found."
            : `${results.length} ${results.length === 1 ? "entry" : "entries"} found.`;

  return (
    <Command shouldFilter={false} loop label="Search entries" className="rounded-none **:data-[slot=command-input-wrapper]:h-12">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search entries…"
        className="h-12 pr-12 text-base sm:text-sm"
        onKeyDown={(event) => {
          // Enter before the first result shows all results in the timeline.
          if (event.key === "Enter" && !event.nativeEvent.isComposing && ready && !results?.length) {
            event.preventDefault();
            viewAll();
          }
        }}
      />
      <p role="status" className={cn("px-4 py-8 text-center text-sm text-muted-foreground", results && results.length > 0 && "sr-only")}>
        {message}
      </p>
      {/* Always rendered: the field points to it with aria-controls. */}
      <CommandList className="max-h-[min(24rem,50vh)]">
        {results && results.length > 0 ? (
          <CommandGroup heading="Entries">
            {results.map((result) => (
              <CommandItem key={result.ref} value={result.ref} onSelect={() => onGo(result.href)} className="gap-3 px-3 py-2.5">
                <span className="w-16 shrink-0 text-xs tabular-nums">{result.ref}</span>
                <span className="min-w-0 flex-1 truncate">{result.title}</span>
                <Badge variant="outline" className="shrink-0 font-normal">
                  {result.kind}
                </Badge>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
      <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
        <span className="hidden items-center gap-3 sm:flex" aria-hidden="true">
          <span className="flex items-center gap-1.5">
            {/* Icons, not arrow characters: not every font has them. */}
            <KbdGroup>
              <Kbd>
                <ArrowUp />
              </Kbd>
              <Kbd>
                <ArrowDown />
              </Kbd>
            </KbdGroup>
            Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>
              <CornerDownLeft />
            </Kbd>
            Open
          </span>
        </span>
        <Button type="button" variant="ghost" size="sm" className="ml-auto h-7" disabled={!ready} onClick={viewAll}>
          View all results
        </Button>
      </div>
    </Command>
  );
}
