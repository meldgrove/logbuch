import { diffWords } from "diff";

export interface DiffPart {
  value: string;
  added: boolean;
  removed: boolean;
}

/** Word-level differences between two versions of a text. */
export function textDiff(before: string, after: string): DiffPart[] {
  return diffWords(before, after).map((part) => ({ value: part.value, added: !!part.added, removed: !!part.removed }));
}

export function hasChanges(parts: DiffPart[]): boolean {
  return parts.some((part) => part.added || part.removed);
}
