/** Entries are shown as LB-<number>, e.g. LB-12. */
export function formatEntryRef(number: number): string {
  return `LB-${number}`;
}

/** Parses "LB-12", "lb12", or "12". Returns undefined for anything else. */
export function parseEntryRef(value: string): number | undefined {
  const match = /^\s*(?:lb-?)?(\d{1,9})\s*$/i.exec(value);
  if (!match?.[1]) return undefined;
  const number = Number(match[1]);
  return number > 0 ? number : undefined;
}

export function entryPath(number: number): string {
  return `/e/${formatEntryRef(number)}`;
}
