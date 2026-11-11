"use client";

import { useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

interface MarkdownFieldProps {
  id: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  rows?: number;
  invalid?: boolean;
  describedBy?: string;
}

/** Textarea with a preview. The textarea stays uncontrolled. */
export function MarkdownField({ id, name, defaultValue, required, rows = 8, invalid, describedBy }: MarkdownFieldProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          aria-label="Editor mode"
          value={preview === null ? "write" : "preview"}
          // Choosing the active mode again would deselect it; keep it instead.
          onValueChange={(mode) => {
            if (mode === "write") setPreview(null);
            if (mode === "preview") setPreview(textarea.current?.value ?? "");
          }}
        >
          <ToggleGroupItem value="write" className="h-7 px-2.5 text-xs">
            Write
          </ToggleGroupItem>
          <ToggleGroupItem value="preview" className="h-7 px-2.5 text-xs">
            Preview
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="ml-auto text-xs text-muted-foreground">Markdown supported</span>
      </div>
      <Textarea
        ref={textarea}
        id={id}
        name={name}
        defaultValue={defaultValue}
        required={required}
        rows={rows}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        hidden={preview !== null}
      />
      {preview !== null ? (
        <div className="min-h-24 rounded-md border bg-muted/30 p-3">
          {preview.trim() ? <Markdown>{preview}</Markdown> : <p className="text-sm text-muted-foreground">Nothing to preview.</p>}
        </div>
      ) : null}
    </div>
  );
}
