import { UsersRound } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** Shown instead of the entry forms while there is no active team: every entry belongs to one. */
export function NoTeamsNotice({ isAdmin, editable }: { isAdmin: boolean; editable: boolean }) {
  let next: React.ReactNode;
  if (!editable) {
    next = "Teams come from the subgroups of the Keycloak teams group. An admin can check the directory sync on the admin page.";
  } else if (isAdmin) {
    next = (
      <>
        Create the first teams under{" "}
        <Link className="underline underline-offset-2" href="/admin/teams">
          Admin → Teams
        </Link>
        .
      </>
    );
  } else {
    next = "An admin needs to create teams first.";
  }
  return (
    <Alert>
      <UsersRound aria-hidden="true" />
      <AlertTitle>No teams yet</AlertTitle>
      <AlertDescription>
        <p>Every entry belongs to a team. {next}</p>
      </AlertDescription>
    </Alert>
  );
}
