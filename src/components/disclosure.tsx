import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface DisclosureProps {
  title: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/** A bordered section that opens on demand, for forms and details most people skip. */
export function Disclosure({ title, children, className }: DisclosureProps) {
  return (
    <Collapsible className={cn("rounded-lg border", className)}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-h-9 w-full justify-between rounded-lg px-3 py-2 text-left whitespace-normal [&[data-state=open]>svg]:rotate-180"
        >
          <span>{title}</span>
          <ChevronDown className="text-muted-foreground transition-transform" aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t p-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}
