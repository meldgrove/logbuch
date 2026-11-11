import { cookies } from "next/headers";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getMyTasks } from "@/lib/process/queries";

/** Set by the sidebar (`src/components/ui/sidebar.tsx`) when it is opened or collapsed. */
const SIDEBAR_COOKIE = "sidebar_state";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { person } = await requireUser();
  const [tasks, cookieStore] = await Promise.all([getMyTasks(getDb(), person.id), cookies()]);
  return (
    <SidebarProvider defaultOpen={cookieStore.get(SIDEBAR_COOKIE)?.value !== "false"}>
      <AppSidebar user={{ name: person.displayName, email: person.workEmail }} isAdmin={person.isAdmin} taskCount={tasks.length} />
      <SidebarInset className="min-w-0">
        <AppHeader />
        <div className="flex-1 px-4 py-6 md:px-8">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
