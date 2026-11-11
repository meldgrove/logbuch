import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signInAction } from "@/app/actions";
import { Logo } from "@/components/logo";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { NO_ACCESS_ERROR_CODE } from "@/lib/auth/access";
import { hasSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  if (error === NO_ACCESS_ERROR_CODE) redirect("/no-access");
  if (await hasSession()) redirect("/");

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center text-center">
          <Logo className="mb-2 size-10" />
          <h1 className="text-xl font-semibold">Logbuch</h1>
          <CardDescription>Decisions, updates, and learnings in one place.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Sign-in failed</AlertTitle>
              <AlertDescription>Please try again. If it keeps failing, contact your administrator.</AlertDescription>
            </Alert>
          ) : null}
          <form action={signInAction}>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
