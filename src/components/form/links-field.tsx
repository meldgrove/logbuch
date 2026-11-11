"use client";

import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LINKS_MAX } from "@/lib/entries/constants";

/** A list of URL inputs, each submitted as `links`. */
export function LinksField({ id, defaultValue = [], describedBy }: { id: string; defaultValue?: string[]; describedBy?: string }) {
  const [rows, setRows] = useState(() =>
    (defaultValue.length > 0 ? defaultValue : [""]).map((value, index) => ({ key: index, value })),
  );
  const [nextKey, setNextKey] = useState(rows.length);

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={row.key} className="flex gap-2">
          <Input
            id={index === 0 ? id : `${id}-${row.key}`}
            name="links"
            type="url"
            inputMode="url"
            placeholder="https://"
            defaultValue={row.value}
            aria-label={index === 0 ? undefined : `Link ${index + 1}`}
            aria-describedby={describedBy}
          />
          {rows.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove link ${index + 1}`}
              onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ))}
      {rows.length < LINKS_MAX ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => {
            setRows((current) => [...current, { key: nextKey, value: "" }]);
            setNextKey((key) => key + 1);
          }}
        >
          <Plus aria-hidden="true" /> Add link
        </Button>
      ) : null}
    </div>
  );
}
