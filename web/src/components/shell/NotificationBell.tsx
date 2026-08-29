"use client";

/**
 * The notification bell.
 *
 * `/me/notifications` has existed since before this console did, and until now
 * nothing on the web ever read it. That was survivable while every event the
 * backend raised also showed up on a screen the user was already looking at.
 * It stopped being survivable with quote requests and purchase-order
 * close-outs: both of those are messages to somebody who is NOT watching the
 * workflow — a vendor who has no idea a buyer just asked them for a price, a
 * supplier whose order was closed as "completed with issues". Without the bell
 * those two features are silent, and a feature nobody is told about is a
 * feature nobody uses.
 *
 * Two things shape the cost model here, and both come from the backend:
 *
 *  - The bell is mounted on every screen, so the CLOSED bell must be cheap.
 *    `/me/notifications/count` exists precisely for this — one indexed count,
 *    no joins, no serialised rows. It polls; the inbox itself does not, and is
 *    not fetched at all until the panel is opened (`enabled: open`).
 *  - A failing bell must never take the shell down. The count query failing
 *    simply means no badge, and the inbox failing renders a compact inline
 *    message inside the panel. Neither throws, and neither is a toast — the
 *    user did not ask for this data, so it must not interrupt them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  CheckCheck,
  CircleCheck,
  ClipboardCheck,
  FileText,
  type LucideIcon,
  MailCheck,
  MessageSquareQuote,
  PackageCheck,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  Button,
  IconButton,
  Skeleton,
  TONE_PILL,
  cn,
  useToast,
} from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime, relativeTime, type Tone } from "@/lib/format";
import { prefetchRoute, prefetchWorkflow } from "@/lib/prefetch";
import type { AppNotification, NotificationKind } from "@/lib/types";

/** Enough to fill the panel several times over. The bell is not an archive. */
const INBOX_LIMIT = 30;

/** Half a minute is fast enough to feel live and slow enough to be free. */
const COUNT_POLL_MS = 30_000;

/* ==========================================================================
   Kind → icon and tone
   ========================================================================== */
interface KindStyle {
  icon: LucideIcon;
  tone: Tone;
}

const KIND_STYLE: Record<NotificationKind, KindStyle> = {
  approval_required: { icon: ClipboardCheck, tone: "warning" },
  approval_decided: { icon: CircleCheck, tone: "positive" },
  po_issued: { icon: FileText, tone: "brand" },
  workflow_escalated: { icon: TriangleAlert, tone: "warning" },
  quote_requested: { icon: MessageSquareQuote, tone: "brand" },
  quote_received: { icon: MailCheck, tone: "positive" },
  po_closed: { icon: PackageCheck, tone: "neutral" },
};

/**
 * A row whose `kind` this build has never heard of still has to render.
 *
 * `kind` is a free-text column on the backend, not an enum with a CHECK
 * constraint, so a newer API can emit a kind this bundle does not know. A
 * generic bell beats a blank cell or a crash.
 */
const UNKNOWN_KIND: KindStyle = { icon: Bell, tone: "neutral" };

/* ==========================================================================
   Deep links
   ========================================================================== */
const DEEP_LINK_SCHEME = "agentflow://";

/**
 * Turn a notification's deep link into a route THIS app has.
 *
 * `deep_link` is a MOBILE deep link. The same notification row also drives the
 * Flutter client's push payload, so the backend writes a custom-scheme URL —
 * `agentflow://workflows/<id>` — that only the phone app registers a handler
 * for. Handing one of those to `router.push` would navigate the browser to a
 * scheme nothing here answers, which in practice is a dead click.
 *
 * So the bell translates the target rather than following it: the host names
 * the resource, and the console has its own route for that resource. Note that
 * the two vendor-portal resources do NOT map one-to-one — a supplier answers
 * quote requests and reads purchase orders from a single list screen each, and
 * there is no per-id route to send them to. Anything unrecognised returns null
 * so the caller can fall back rather than guess.
 *
 * Pure by design: no router, no state, nothing to mock if it ever needs a test.
 */
function translate(deepLink: string | null): string | null {
  if (!deepLink || !deepLink.startsWith(DEEP_LINK_SCHEME)) return null;
  const [resource, id] = deepLink.slice(DEEP_LINK_SCHEME.length).split("/");
  switch (resource) {
    case "workflows":
      return id ? `/workflows/${id}` : null;
    case "approvals":
      return id ? `/admin/approvals/${id}` : null;
    case "quote-requests":
      return "/portal/quotes";
    case "purchase-orders":
      return "/portal/orders";
    default:
      return null;
  }
}

/**
 * Where a row should take the reader — the deep link first, then the workflow
 * the notification hangs off, then nowhere. "Nowhere" is a real answer: the
 * row is still marked read, because the user did read it.
 */
function routeFor(item: AppNotification): string | null {
  return (
    translate(item.deep_link) ??
    (item.workflow_id ? `/workflows/${item.workflow_id}` : null)
  );
}

/* ==========================================================================
   One row
   ========================================================================== */
const ROW_CLASS =
  "relative flex w-full items-start gap-3 px-4 py-3.5 text-left " +
  "transition-colors hover:bg-white/70";

/**
 * The row's contents, shared by both of its shells.
 *
 * A row that HAS somewhere to go renders as an anchor, so it behaves like the
 * link it is — middle-click, ⌘-click and the status bar all work, and a screen
 * reader announces a link rather than a button. A row with no route (a kind
 * this build cannot place, or a notification carrying neither a deep link nor
 * a workflow) still renders and is still marked read; it just does not move.
 */
function RowBody({ item, unread }: { item: AppNotification; unread: boolean }) {
  const style = KIND_STYLE[item.kind] ?? UNKNOWN_KIND;
  const Icon = style.icon;
  return (
    <>
      {unread && (
        <span
          aria-hidden
          className="gradient-cta absolute bottom-3 left-0 top-3 w-[3px] rounded-r-full"
        />
      )}
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-9 shrink-0 place-items-center rounded-[12px] border",
          TONE_PILL[style.tone],
        )}
      >
        <Icon className="size-[17px]" strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-[12.5px] font-semibold leading-snug tracking-[-0.01em]",
            unread ? "text-[#243640]" : "text-[#5f7280]",
          )}
        >
          {item.title}
        </span>
        <span
          className={cn(
            "mt-0.5 line-clamp-2 block text-[12px] leading-relaxed",
            unread ? "text-[#5f7280]" : "text-[#7e8c94]",
          )}
        >
          {item.body}
        </span>
        <span
          className="mt-1.5 block text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#93a7b1]"
          title={dateTime(item.created_at)}
        >
          {relativeTime(item.created_at)}
        </span>
      </span>
    </>
  );
}

/* ==========================================================================
   Bell
   ========================================================================== */
export function NotificationBell() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The closed bell's entire cost: one count, polled.
  const countQuery = useQuery({
    queryKey: ["notifications", "count"],
    queryFn: () => api.unreadCount(),
    refetchInterval: COUNT_POLL_MS,
  });

  // The inbox is only worth a round trip once somebody is actually looking.
  const inboxQuery = useQuery({
    queryKey: ["notifications", "inbox", INBOX_LIMIT],
    queryFn: () => api.notifications(INBOX_LIMIT),
    enabled: open,
  });

  // While the panel is open the inbox's own count is the fresher of the two —
  // it was fetched on open, whereas the poll may be most of a minute old — and
  // it is the one that agrees with the rows on screen.
  const unread =
    (open ? inboxQuery.data?.unread_count : undefined) ??
    countQuery.data?.unread_count ??
    0;

  const markRead = useMutation({
    mutationFn: (ids: string[] | undefined) => api.markNotificationsRead(ids),
    onSuccess: (_result, ids) => {
      // The list and the badge are separate queries and both are now wrong.
      // One prefix invalidation covers both — ["notifications"] is a prefix of
      // ["notifications", "count"] and of the inbox key.
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
      // Only the deliberate "mark all" is worth confirming; marking one read
      // is a side effect of opening it, and the row visibly changes anyway.
      if (!ids) toast("All notifications marked read.");
    },
    onError: (error) => {
      toast(error.message || "Could not update notifications.", "danger");
    },
  });

  // Outside click and Escape. Bound only while open, removed on cleanup, so a
  // closed bell holds no document listeners at all.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Escape has to hand focus back to the trigger. Dropping it on the body
      // would strand a keyboard user at the top of the document, which is a
      // long way from where they were.
      rootRef.current?.querySelector("button")?.focus();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Reading a row is what marks it read; the anchor does the navigating.
  const openItem = (item: AppNotification) => {
    setOpen(false);
    if (!item.read) markRead.mutate([item.id]);
  };

  // Same trick the rail uses: a hover is a few hundred milliseconds of warning
  // before the click, which is most of one round trip to Supabase's region.
  const warm = (href: string) => {
    const workflow = /^\/workflows\/([^/]+)$/.exec(href);
    if (workflow) prefetchWorkflow(queryClient, workflow[1]);
    else prefetchRoute(queryClient, href);
  };

  const items = inboxQuery.data?.items ?? [];

  return (
    <div ref={rootRef} className="relative">
      <IconButton
        label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(open && "bg-white/80 text-[#243640]")}
        icon={
          <>
            <Bell className="size-[18px]" strokeWidth={2} />
            {unread > 0 && (
              <span
                aria-hidden
                className="gradient-cta tnum absolute -right-1 -top-1 grid h-[17px] min-w-[17px] place-items-center rounded-full px-1 text-[9.5px] font-bold leading-none text-white ring-2 ring-white/85"
              >
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </>
        }
      />

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="glass-soft animate-fade-in absolute right-0 top-full z-50 mt-2.5 max-h-[70vh] w-[380px] max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-[24px]"
        >
          <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/60 bg-white/70 px-4 py-3 backdrop-blur-xl">
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold tracking-[-0.01em] text-[#243640]">
                Notifications
              </p>
              <p className="tnum mt-0.5 text-[11.5px] font-medium text-[#7e8c94]">
                {unread > 0 ? `${unread} unread` : "All caught up"}
              </p>
            </div>
            {unread > 0 && (
              <Button
                size="sm"
                variant="ghost"
                loading={markRead.isPending && markRead.variables === undefined}
                icon={<CheckCheck className="size-3.5" />}
                onClick={() => markRead.mutate(undefined)}
                className="shrink-0"
              >
                Mark all read
              </Button>
            )}
          </div>

          {/* isPending, not isLoading: the query is only enabled the moment
              the panel opens, and on that first frame it is pending but not
              yet fetching — isLoading would be false and the empty state
              would flash before the request had even left. */}
          {inboxQuery.isPending && (
            <div className="space-y-2 p-4">
              {[0, 1, 2, 3].map((row) => (
                <Skeleton key={row} className="h-[62px]" />
              ))}
            </div>
          )}

          {/* A failure with rows already cached is a failed REFRESH, not an
              empty inbox — the rows below are still true, just older. */}
          {inboxQuery.isError && items.length === 0 && (
            <div className="px-4 py-6">
              <p className="text-[12.5px] font-semibold text-[#b42318]">
                Could not load notifications.
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-[#7e8c94]">
                {inboxQuery.error instanceof Error
                  ? inboxQuery.error.message
                  : "The inbox is unavailable right now."}
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-3"
                onClick={() => void inboxQuery.refetch()}
              >
                Try again
              </Button>
            </div>
          )}

          {!inboxQuery.isPending && !inboxQuery.isError && items.length === 0 && (
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <span className="mb-3.5 grid size-12 place-items-center rounded-[16px] bg-white/80 text-[#93a7b1] shadow-[0_8px_20px_rgba(46,96,120,0.10)]">
                <BellOff className="size-5" strokeWidth={2} />
              </span>
              <p className="text-[13.5px] font-semibold text-[#243640]">
                Nothing new.
              </p>
              {/* Deliberately audience-neutral: the same bell serves a buyer
                  waiting on an approval and a supplier being asked for a
                  price, and neither should read someone else's inbox here. */}
              <p className="mt-1.5 max-w-[250px] text-[12px] leading-relaxed text-[#7e8c94]">
                Approvals, purchase orders and quote-request activity all land
                here.
              </p>
            </div>
          )}

          {items.length > 0 && (
            <>
              {inboxQuery.isError && (
                <p className="border-b border-[#fedf89] bg-[#fffaeb] px-4 py-2 text-[11.5px] font-medium leading-relaxed text-[#b54708]">
                  Could not refresh — these are the last rows we received.
                </p>
              )}
              <ul className="divide-y divide-[#e7eff3]/70">
                {items.map((item) => {
                  const unreadRow = !item.read;
                  const href = routeFor(item);
                  const rowClass = cn(
                    ROW_CLASS,
                    unreadRow ? "bg-[#d6ebf3]/25" : "bg-transparent",
                  );
                  return (
                    <li key={item.id}>
                      {href ? (
                        <Link
                          href={href}
                          onClick={() => openItem(item)}
                          onMouseEnter={() => warm(href)}
                          onPointerDown={() => warm(href)}
                          className={rowClass}
                        >
                          <RowBody item={item} unread={unreadRow} />
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openItem(item)}
                          className={rowClass}
                        >
                          <RowBody item={item} unread={unreadRow} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
