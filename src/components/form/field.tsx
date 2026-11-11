import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field as FieldRoot, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";

interface FieldProps {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}

/** Label, control, hint, and error message. Controls use `${id}-error` for aria-describedby. */
export function Field({ id, label, required, hint, error, children }: FieldProps) {
  return (
    <FieldRoot data-invalid={error ? true : undefined} className="gap-2">
      <FieldLabel htmlFor={id} className="gap-1">
        {label}
        {required ? null : (
          <>
            {" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </>
        )}
      </FieldLabel>
      {children}
      {hint ? (
        <FieldDescription id={`${id}-hint`} className="text-xs">
          {hint}
        </FieldDescription>
      ) : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </FieldRoot>
  );
}

export function describedBy(id: string, error?: string, hint?: string): string | undefined {
  return [hint ? `${id}-hint` : undefined, error ? `${id}-error` : undefined].filter(Boolean).join(" ") || undefined;
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
