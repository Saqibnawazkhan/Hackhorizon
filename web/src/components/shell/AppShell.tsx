"use client";

/**
 * The console chrome: a persistent rail, a translucent top bar and the page
 * body. The rail is role-aware — an employee never sees the approval queue,
 * a vendor never sees buyer workflows — which mirrors the API's own role
 * guards rather than merely decorating them.
 */
import {
  Boxes,
  ClipboardCheck,
  Coins,
  FileSpreadsheet,
  Gauge,
  History,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  MessageSquareQuote,
  PackageSearch,
  Plug,
  ScrollText,
  Send,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Store,
  Truck,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { NotificationBell } from "@/components/shell/NotificationBell";
import { Avatar, Button, Spinner, cn } from "@/components/ui";
import { homeRouteFor, useAuth } from "@/lib/auth";
import { prefetchHome, prefetchRoute } from "@/lib/prefetch";
import type { UserRole } from "@/lib/types";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Match child routes too (e.g. /workflows/abc under /workflows). */
  prefix?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const EMPLOYEE_NAV: NavGroup[] = [
  {
    label: "Work",
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
      { href: "/requests/new", label: "New request", icon: Send },
      { href: "/workflows", label: "Workflows", icon: History, prefix: true },
    ],
  },
  {
    label: "Supply",
    items: [
      { href: "/vendors", label: "Vendors", icon: Users, prefix: true },
      { href: "/catalog", label: "Catalog", icon: PackageSearch },
    ],
  },
  {
    label: "System",
    items: [{ href: "/system", label: "Agent internals", icon: Server }],
  },
];

const ADMIN_NAV: NavGroup[] = [
  {
    label: "Oversight",
    items: [
      { href: "/admin", label: "Dashboard", icon: Gauge },
      {
        href: "/admin/approvals",
        label: "Approvals",
        icon: ClipboardCheck,
        prefix: true,
      },
      { href: "/workflows", label: "Workflows", icon: History, prefix: true },
    ],
  },
  {
    label: "Governance",
    items: [
      { href: "/admin/vendors", label: "Vendors", icon: ShieldCheck },
      { href: "/admin/scoring", label: "Scoring weights", icon: SlidersHorizontal },
      { href: "/admin/policies", label: "Policy rules", icon: ScrollText },
      { href: "/admin/spend", label: "Spend", icon: Coins },
    ],
  },
  {
    label: "Work",
    items: [
      { href: "/requests/new", label: "New request", icon: Send },
      { href: "/catalog", label: "Catalog", icon: PackageSearch },
      { href: "/system", label: "Agent internals", icon: Server },
    ],
  },
];

const VENDOR_NAV: NavGroup[] = [
  {
    label: "Storefront",
    items: [
      { href: "/portal", label: "My catalog", icon: Boxes },
      // Buyers asking for a price the catalog could not answer. This is the
      // one screen where a vendor can win business they were not already
      // listed for, so it sits above purchase orders.
      { href: "/portal/quotes", label: "Quote requests", icon: MessageSquareQuote },
      { href: "/portal/orders", label: "Purchase orders", icon: Truck },
    ],
  },
  {
    label: "Data",
    items: [
      { href: "/portal/imports", label: "Spreadsheet import", icon: FileSpreadsheet },
      { href: "/portal/connections", label: "Connections", icon: Plug },
    ],
  },
];

function navFor(role: UserRole): NavGroup[] {
  if (role === "admin") return ADMIN_NAV;
  if (role === "vendor") return VENDOR_NAV;
  return EMPLOYEE_NAV;
}

const ROLE_LABEL: Record<UserRole, string> = {
  employee: "Employee",
  admin: "Administrator",
  vendor: "Vendor",
};

function isActive(pathname: string, item: NavItem): boolean {
  if (item.prefix) {
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }
  return pathname === item.href;
}

function Brand({ vendor }: { vendor: boolean }) {
  return (
    <div className="flex items-center gap-3 px-2">
      <span
        className={cn(
          "grid size-10 place-items-center rounded-[14px] text-white",
          vendor
            ? "bg-[#447f98] shadow-[0_8px_14px_rgba(68,127,152,0.30)]"
            : "gradient-cta shadow-[0_10px_20px_rgba(46,96,120,0.30)]",
        )}
      >
        <Sparkles className="size-5" strokeWidth={2.2} />
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-bold leading-tight tracking-[-0.02em] text-[#243640]">
          AgentFlow
        </p>
        <p className="truncate text-[10.5px] font-medium uppercase tracking-[0.1em] text-[#7e8c94]">
          {vendor ? "Vendor portal" : "Workflow console"}
        </p>
      </div>
    </div>
  );
}

function NavList({
  groups,
  pathname,
  onNavigate,
}: {
  groups: NavGroup[];
  pathname: string;
  onNavigate?: () => void;
}) {
  const queryClient = useQueryClient();

  // Hovering a nav item is a reliable few hundred milliseconds of warning
  // before the click, which is most of one round trip to Supabase's region.
  // Spending it fetching means the route usually mounts against a warm cache
  // instead of a spinner. Touch devices get the same benefit from the
  // pointerdown that precedes the click.
  const warm = (href: string) => prefetchRoute(queryClient, href);

  return (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-2">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#a3b6c0]">
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    onMouseEnter={() => warm(item.href)}
                    onFocus={() => warm(item.href)}
                    onPointerDown={() => warm(item.href)}
                    className={cn(
                      "group relative flex items-center gap-3 rounded-[14px] px-3 py-2.5 text-[13px] font-medium transition-all duration-200",
                      active
                        ? "bg-white/85 text-[#243640] shadow-[0_6px_18px_rgba(46,96,120,0.12)]"
                        : "text-[#5f7280] hover:bg-white/55 hover:text-[#243640]",
                    )}
                  >
                    {active && (
                      <span className="gradient-cta absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full" />
                    )}
                    <Icon
                      className={cn(
                        "size-[18px] shrink-0 transition-colors",
                        active
                          ? "text-[#447f98]"
                          : "text-[#93a7b1] group-hover:text-[#5f7280]",
                      )}
                      strokeWidth={2}
                    />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  // The first screen after sign-in is the slowest moment in the app: nothing
  // is cached, and the shell cannot render until the session resolves. Firing
  // the landing route's queries the instant we know the role overlaps that
  // fetch with the shell's own render instead of queuing it behind one.
  const role = user?.role;
  useEffect(() => {
    if (role) prefetchHome(queryClient, role);
  }, [role, queryClient]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const groups = useMemo(() => navFor(user?.role ?? "employee"), [user?.role]);
  const vendor = user?.role === "vendor";

  if (loading || !user) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="flex items-center gap-3 text-[13px] text-[#5f7280]">
          <Spinner />
          Restoring your session…
        </div>
      </div>
    );
  }

  const displayName = user.fullName ?? user.email?.split("@")[0] ?? "You";

  const rail = (
    <>
      <div className="px-3 pb-4 pt-5">
        <Link href={homeRouteFor(user.role)}>
          <Brand vendor={vendor} />
        </Link>
      </div>
      <NavList groups={groups} pathname={pathname} onNavigate={() => setMobileOpen(false)} />
      <div className="border-t border-white/60 p-3">
        <div className="flex items-center gap-3 rounded-[16px] bg-white/60 p-2.5">
          <Avatar name={displayName} size={34} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-semibold text-[#243640]">
              {displayName}
            </p>
            <p className="truncate text-[10.5px] font-medium uppercase tracking-[0.08em] text-[#7e8c94]">
              {ROLE_LABEL[user.role]}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            title="Sign out"
            aria-label="Sign out"
            className="grid size-8 shrink-0 place-items-center rounded-[10px] text-[#93a7b1] transition-colors hover:bg-white hover:text-[#b42318]"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop rail */}
      <aside className="glass-soft sticky top-0 hidden h-dvh w-[260px] shrink-0 flex-col rounded-none border-y-0 border-l-0 lg:flex">
        {rail}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="animate-fade-in absolute inset-0 bg-[#16323f]/35 backdrop-blur-[3px]"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="glass-soft animate-fade-in absolute inset-y-0 left-0 flex w-[276px] flex-col rounded-none">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-4 grid size-8 place-items-center rounded-[10px] text-[#5f7280] hover:bg-white/70"
            >
              <X className="size-4" />
            </button>
            {rail}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass-soft sticky top-0 z-40 flex h-16 items-center gap-3 rounded-none border-x-0 border-t-0 px-4 sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="grid size-9 place-items-center rounded-[12px] text-[#5f7280] hover:bg-white/70 lg:hidden"
          >
            <Menu className="size-5" />
          </button>
          <div className="lg:hidden">
            <Brand vendor={vendor} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            {/* Quote requests and PO close-outs both notify through
                /me/notifications. Without the bell those features are silent:
                a vendor would never learn a buyer had asked them for a price. */}
            <NotificationBell />
            {user.role !== "vendor" && (
              <Button
                size="sm"
                variant="primary"
                icon={<Send className="size-3.5" />}
                onClick={() => router.push("/requests/new")}
                className="hidden sm:inline-flex"
              >
                New request
              </Button>
            )}
            {user.role === "vendor" && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Store className="size-3.5" />}
                onClick={() => router.push("/portal")}
                className="hidden sm:inline-flex"
              >
                My catalog
              </Button>
            )}
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 pb-16 pt-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-[1400px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

/** The standard page heading: title, subtitle, actions, optional breadcrumb. */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        {breadcrumb && <div className="mb-2">{breadcrumb}</div>}
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.03em] text-[#243640]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-[#5f7280]">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
