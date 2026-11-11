"use client";

import {
  ChartColumn,
  ChevronsUpDown,
  ListChecks,
  LogOut,
  ScrollText,
  Settings,
  SlidersHorizontal,
  SquarePen,
  Tags,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import { signOutAction } from "@/app/actions";
import { EntrySearch, SearchButton } from "@/components/entry-search";
import { Logo } from "@/components/logo";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { activeNavKey, ADMIN_NAV, MAIN_NAV, NEW_ENTRY, type NavKey } from "@/lib/navigation";

const ICONS: Record<NavKey, LucideIcon> = {
  new: SquarePen,
  timeline: ScrollText,
  tasks: ListChecks,
  stats: ChartColumn,
  admin: Settings,
  people: Users,
  teams: UsersRound,
  tags: Tags,
};

interface AppSidebarProps {
  user: { name: string; email: string | null };
  isAdmin: boolean;
  taskCount: number;
}

/** The app's navigation, collapsible to icons; a sheet on small screens. */
export function AppSidebar({ user, isAdmin, taskCount }: AppSidebarProps) {
  const active = activeNavKey(usePathname());
  const { isMobile, setOpenMobile } = useSidebar();
  // On small screens the sidebar is a sheet that stays open after navigating.
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const NewEntryIcon = ICONS[NEW_ENTRY.key];
  // Here, outside the sidebar: on small screens its contents unmount with the sheet.
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <Link href="/" onClick={closeOnMobile}>
                  {/* Wrapped: the menu button shrinks direct svg children to icon size. */}
                  <span className="flex size-8 shrink-0 items-center justify-center">
                    <Logo className="size-8" />
                  </span>
                  <span className="grid flex-1 text-left leading-tight">
                    <span className="truncate font-semibold">Logbuch</span>
                    <span className="truncate text-xs text-muted-foreground">Decisions and updates</span>
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SearchButton
                onClick={() => {
                  closeOnMobile();
                  setSearchOpen(true);
                }}
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent className="flex flex-col gap-2">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip={NEW_ENTRY.label}
                    isActive={active === NEW_ENTRY.key}
                    className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground data-[active=true]:bg-primary data-[active=true]:text-primary-foreground"
                  >
                    <Link href={NEW_ENTRY.href} onClick={closeOnMobile}>
                      <NewEntryIcon aria-hidden="true" />
                      <span>{NEW_ENTRY.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
              <SidebarMenu>
                {MAIN_NAV.map((item) => {
                  const Icon = ICONS[item.key];
                  return (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton asChild tooltip={item.label} isActive={active === item.key}>
                        <Link href={item.href} onClick={closeOnMobile} aria-current={active === item.key ? "page" : undefined}>
                          <Icon aria-hidden="true" />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                      {item.key === "tasks" && taskCount > 0 ? (
                        <SidebarMenuBadge className="rounded-full bg-primary text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground">
                          {taskCount}
                          <span className="sr-only"> waiting</span>
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {isAdmin ? (
            <SidebarGroup>
              <SidebarGroupLabel>Administration</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {ADMIN_NAV.map((item) => {
                    const Icon = ICONS[item.key];
                    return (
                      <SidebarMenuItem key={item.key}>
                        <SidebarMenuButton asChild tooltip={item.label} isActive={active === item.key}>
                          <Link href={item.href} onClick={closeOnMobile} aria-current={active === item.key ? "page" : undefined}>
                            <Icon aria-hidden="true" />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
        </SidebarContent>

        <SidebarFooter>
          <NavUser name={user.name} email={user.email} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <EntrySearch open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words.at(-1)!] : words;
  return letters.map((word) => word[0]!.toUpperCase()).join("") || "?";
}

/** Avatar, name, and email of the signed-in person. */
function PersonSummary({ name, email, nameTestId }: { name: string; email: string | null; nameTestId?: string }) {
  return (
    <>
      <Avatar className="size-8 rounded-lg">
        <AvatarFallback className="rounded-lg bg-primary text-xs font-medium text-primary-foreground">{initials(name)}</AvatarFallback>
      </Avatar>
      <span className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium" data-testid={nameTestId}>
          {name}
        </span>
        {email ? <span className="truncate text-xs text-muted-foreground">{email}</span> : null}
      </span>
    </>
  );
}

/** The signed-in person with the account menu. */
function NavUser({ name, email }: { name: string; email: string | null }) {
  const { isMobile } = useSidebar();
  const signOut = useRef<HTMLFormElement>(null);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        {/* Outside the menu, which unmounts when an item is chosen. */}
        <form ref={signOut} action={signOutAction} hidden />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
              <PersonSummary name={name} email={email} nameTestId="current-user" />
              <ChevronsUpDown className="ml-auto" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
            <DropdownMenuLabel className="flex items-center gap-2 px-1 py-1.5 font-normal">
              <PersonSummary name={name} email={email} />
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <SlidersHorizontal aria-hidden="true" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => signOut.current?.requestSubmit()}>
              <LogOut aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
