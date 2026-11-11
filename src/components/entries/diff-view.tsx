import type { DiffPart } from "@/lib/entries/diff";

/** Shows removed words struck through and added words highlighted. */
export function DiffView({ parts }: { parts: DiffPart[] }) {
  return (
    <p className="text-sm break-words whitespace-pre-wrap">
      {parts.map((part, index) =>
        part.added ? (
          <ins key={index} className="bg-green-100 text-green-900 no-underline dark:bg-green-900/40 dark:text-green-100">
            {part.value}
          </ins>
        ) : part.removed ? (
          <del key={index} className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100">
            {part.value}
          </del>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </p>
  );
}
