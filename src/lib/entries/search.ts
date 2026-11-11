/**
 * The words of a search as a PostgreSQL tsquery: every word must match, and
 * the last one may be the start of a word, so the search finds entries while
 * someone is still typing. Each word is quoted, so PostgreSQL's parser reads
 * it as in the text: example.org, an email address, or 1.600 stays one word.
 * Inside quotes only ' and \ are special, and they never reach the query,
 * nor does NUL, which PostgreSQL rejects in text. Undefined when the search
 * has no words.
 */
export function searchTsQuery(q: string): string | undefined {
  const words = q
    .replace(/['\\\0]/g, " ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, 20);
  if (!words.length) return undefined;
  return words.map((word, index) => `'${word}'${index === words.length - 1 ? ":*" : ""}`).join(" & ");
}

/** One entry the search in the sidebar found (`/api/search`). */
export interface SearchResult {
  ref: string;
  title: string;
  /** The entry's type, or where a proposal stands. */
  kind: string;
  href: string;
}
