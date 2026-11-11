"use client";

import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";

/**
 * A GET form that navigates on the client and leaves empty fields out of the
 * URL. Without JavaScript it submits as a plain GET form.
 */
export function SearchForm({ action, children, ...props }: Omit<ComponentProps<"form">, "action" | "method" | "onSubmit"> & { action: string }) {
  const router = useRouter();
  return (
    <form
      {...props}
      method="get"
      action={action}
      onSubmit={(event) => {
        event.preventDefault();
        const params = new URLSearchParams();
        for (const [name, value] of new FormData(event.currentTarget)) {
          if (typeof value === "string" && value.trim()) params.append(name, value.trim());
        }
        const query = params.toString();
        router.push(query ? `${action}?${query}` : action);
      }}
    >
      {children}
    </form>
  );
}
