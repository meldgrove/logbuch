import type { Metadata } from "next";
import { signOutAction } from "@/app/actions";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "No access" };

export default function NoAccessPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <Logo className="mb-2 size-10" />
          <h1 className="text-xl font-semibold">No access to Logbuch</h1>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <p>
            You signed in, but your account has no access to Logbuch. An admin needs to invite you, or to add you to the
            right group in your organization&apos;s directory.
          </p>
          <p>If you were invited, sign in with the email address of your invitation. If you think this is wrong, contact your administrator.</p>
          <form action={signOutAction}>
            <Button type="submit" variant="outline">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
