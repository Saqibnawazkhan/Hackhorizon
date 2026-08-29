"use client";

/**
 * Screen 8a — the approval queue.
 *
 * Every row here is a LangGraph run frozen inside `route_approval` at an
 * `interrupt()`. The checkpointed state is durable, nothing has been
 * committed, and there is no path forward that does not pass through a human:
 * the agent never auto-approves. That is also why an item's age is not a
 * neutral fact — a queue 30 hours deep is a workflow that has been blocked for
 * 30 hours — so anything past a day is flagged rather than merely sorted.
 *
 * The list endpoint returns pending approvals only, newest first, so the queue
 * never mixes decided work into the backlog.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  Clock3,
  Coins,
  Landmark,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Mono,
  Skeleton,
  StatTile,
  StatusPill,
  cn,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  asNumber,
  dateTime,
  money,
  moneyCompact,
  number,
  parseDate,
  relativeTime,
} from "@/lib/format";
import type { ApprovalListItem } from "@/lib/types";

const PAGE_SIZE = 10;

/* --------------------------------------------------------------------------
   Derivations — kept out of the markup so the card reads as layout only
   -------------------------------------------------------------------------- */

/** Hours a request has been sitting at the gate, or null if the date is bad. */
function ageHours(iso: string): number | null {
  const requested = parseDate(iso);
  if (!requested) return null;
  return (Date.now() - requested.getTime()) / 3_600_000;
}

function staleLabel(hours: number): string {
  const days = Math.floor(hours / 24);
  if (days >= 2) return `Blocked ${days} days`;
  return "Blocked over 24 hours";
}

/**
 * The page's value at stake. Only summed when every priced item shares one
 * currency — adding PKR to USD would be a lie dressed as a statistic.
 */
function pageValue(items: ApprovalListItem[]) {
  const priced = items.filter((item) => asNumber(item.total_amount) !== null);
  if (priced.length === 0) return null;
  const currencies = new Set(priced.map((item) => item.currency ?? ""));
  if (currencies.size > 1) return null;
  return {
    amount: priced.reduce((sum, item) => sum + (asNumber(item.total_amount) ?? 0), 0),
    currency: priced[0].currency ?? undefined,
    counted: priced.length,
  };
}

/* --------------------------------------------------------------------------
   Local pieces
   -------------------------------------------------------------------------- */

function Figure({
  label,
  value,
  hint,
  tone = "ink",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ink" | "positive" | "danger" | "muted";
}) {
  return (
    <div className="glass-flat rounded-[18px] px-4 py-3.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
        {label}
      </p>
      <p
        className={cn(
          "mt-1.5 text-[17px] font-bold leading-none tracking-[-0.02em] tnum",
          tone === "ink" && "text-[#243640]",
          tone === "positive" && "text-[#067647]",
          tone === "danger" && "text-[#b42318]",
          tone === "muted" && "text-[#7e8c94]",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1.5 text-[11.5px] text-[#7e8c94]">{hint}</p>}
    </div>
  );
}

function QueueCard({ item }: { item: ApprovalListItem }) {
  const currency = item.currency ?? undefined;
  const hours = ageHours(item.requested_at);
  const stale = hours !== null && hours >= 24;

  const orderTotal = asNumber(item.total_amount);
  const budget = asNumber(item.budget);
  const delta = orderTotal !== null && budget !== null ? orderTotal - budget : null;
  const over = delta !== null && delta > 0;

  return (
    <Card
      as="li"
      variant="glass"
      padded={false}
      className="animate-fade-up p-6 transition-all duration-200 hover:shadow-[0_26px_54px_rgba(46,96,120,0.28)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
              Purchase order
            </span>
            {item.po_number ? (
              <Mono>{item.po_number}</Mono>
            ) : (
              <span className="text-[12px] text-[#7e8c94]">No order attached</span>
            )}
          </div>
          <h3 className="mt-2 text-[17px] font-bold leading-snug tracking-[-0.02em] text-[#243640]">
            {item.title || "Untitled request"}
          </h3>
          <p className="mt-1 text-[12px] text-[#7e8c94]" title={dateTime(item.requested_at)}>
            Paused at the gate {relativeTime(item.requested_at)}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {stale && hours !== null && (
            <StatusPill tone="warning" label={staleLabel(hours)} />
          )}
          <StatusPill tone="brand" label="Awaiting your decision" />
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Figure
          label="Order total"
          value={money(item.total_amount, currency)}
          tone={orderTotal === null ? "muted" : "ink"}
          hint={orderTotal === null ? "Not priced yet" : "From the generated order"}
        />
        <Figure
          label="Budget"
          value={money(item.budget, currency)}
          tone={budget === null ? "muted" : "ink"}
          hint={budget === null ? "None recorded" : "Recorded on the request"}
        />
        <Figure
          label={over ? "Over budget" : "Headroom"}
          value={delta === null ? "—" : money(Math.abs(delta), currency)}
          tone={delta === null ? "muted" : over ? "danger" : "positive"}
          hint={
            delta === null
              ? "Nothing to compare"
              : over
                ? "Above the recorded budget"
                : "Left inside the budget"
          }
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-lg text-[12.5px] leading-relaxed text-[#5f7280]">
          {delta === null
            ? "No budget was recorded on this request, so the total cannot be checked against one."
            : over
              ? "This total sits above the budget the requester recorded. Read the trace before committing it."
              : "This total fits inside the budget the requester recorded."}
        </p>
        <Link
          href={`/admin/approvals/${item.id}`}
          className={cn(
            "gradient-cta inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-[14px] px-5",
            "text-[13.5px] font-semibold tracking-[-0.01em] text-white",
            "shadow-[0_14px_28px_rgba(46,96,120,0.32)] transition-all duration-200",
            "hover:shadow-[0_18px_34px_rgba(46,96,120,0.40)] hover:brightness-[1.04] active:translate-y-px",
          )}
        >
          Review and decide
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </Card>
  );
}

function ForbiddenPanel() {
  return (
    <Card className="animate-fade-up mx-auto max-w-2xl text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-[18px] bg-[#e9f3f8] text-[#38677b]">
        <ShieldCheck className="size-6" />
      </div>
      <h2 className="mt-4 text-[16px] font-semibold tracking-[-0.02em] text-[#243640]">
        Not visible to this account
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[#5f7280]">
        The API refuses the approval queue to supplier accounts: reading the
        buyer&rsquo;s gate would expose what every other supplier was quoted.
        Deciding is narrower still — that is reserved for administrators, and
        the agent itself is never given it.
      </p>
      <Link
        href="/dashboard"
        className="mt-5 inline-flex h-10 items-center gap-2 rounded-[14px] border border-white/80 bg-white/75 px-4 text-[13px] font-semibold text-[#243640] shadow-[0_8px_22px_rgba(46,96,120,0.10)] transition-colors duration-200 hover:bg-white/95"
      >
        Back to your overview
        <ArrowRight className="size-4" />
      </Link>
    </Card>
  );
}

/* --------------------------------------------------------------------------
   Page
   -------------------------------------------------------------------------- */
export default function ApprovalQueuePage() {
  const [offset, setOffset] = useState(0);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["approvals", { limit: PAGE_SIZE, offset }],
    queryFn: () => api.listApprovals({ limit: PAGE_SIZE, offset }),
    // Without this a page change re-enters the pending state, the skeleton
    // replaces the whole queue — pager included — and the reader loses the
    // control they just pressed. Keeping the previous page on screen is also
    // what makes the `isFetching` guards on Previous/Next mean anything.
    placeholderData: keepPreviousData,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const value = pageValue(items);

  const oldest = items.reduce<ApprovalListItem | null>((worst, item) => {
    if (!worst) return item;
    return item.requested_at < worst.requested_at ? item : worst;
  }, null);
  const oldestHours = oldest ? ageHours(oldest.requested_at) : null;
  const staleCount = items.filter((item) => {
    const hours = ageHours(item.requested_at);
    return hours !== null && hours >= 24;
  }).length;

  const forbidden = error instanceof ApiError && error.isForbidden;

  return (
    <>
      <PageHeader
        title="Approval queue"
        description="Purchase orders the agent generated, validated, and then handed to a human. Nothing below has been committed."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />}
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            Refresh
          </Button>
        }
      />

      {/* The gate, stated outright. This is the one screen where the mechanism
          has to be explained rather than implied. */}
      <Card className="animate-fade-up mb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <span className="gradient-cta grid size-12 shrink-0 place-items-center rounded-[18px] text-white shadow-[0_12px_24px_rgba(46,96,120,0.30)]">
            <Landmark className="size-6" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
              Execution is paused, not finished
            </h2>
            <p className="mt-1.5 max-w-3xl text-[13.5px] leading-relaxed text-[#5f7280]">
              Each workflow below stopped inside <Mono>route_approval</Mono> at an{" "}
              <Mono>interrupt()</Mono>. Its state is checkpointed and the run is
              suspended mid-graph: the agent has no branch that continues without
              a decision, and it never approves its own work. Approving or
              rejecting here is the only thing that resumes the graph, and the
              decision is recorded against your account before it does.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <StatusPill tone="neutral" dot={false} label="State checkpointed" />
              <StatusPill tone="neutral" dot={false} label="No spend committed" />
              <StatusPill tone="neutral" dot={false} label="An administrator resumes it" />
            </div>
          </div>
        </div>
      </Card>

      {isLoading ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-[118px] rounded-[28px]" />
            <Skeleton className="h-[118px] rounded-[28px]" />
            <Skeleton className="h-[118px] rounded-[28px]" />
          </div>
          <Skeleton className="h-[248px] rounded-[28px]" />
          <Skeleton className="h-[248px] rounded-[28px]" />
        </div>
      ) : forbidden ? (
        <ForbiddenPanel />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : items.length === 0 && offset > 0 ? (
        /* Not an empty queue — an empty PAGE. Approvals that were here have
           been decided since this offset was opened, and without a way back
           the reader is stranded on a page that can never refill. */
        <EmptyState
          icon={<CircleCheckBig className="size-6" />}
          title="This page of the queue is now empty."
          description="The approvals that were on this page have since been decided, so the queue is shorter than it was when you opened it."
          action={
            <Button variant="secondary" onClick={() => setOffset(0)}>
              Back to the first page
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<CircleCheckBig className="size-6" />}
          title="Nothing is waiting on you."
          description="No workflow is currently suspended at the approval gate. When the agent finishes generating and validating a purchase order it stops here, and the run appears in this queue."
          action={
            <Link
              href="/workflows"
              className="inline-flex h-10 items-center gap-2 rounded-[14px] border border-white/80 bg-white/75 px-4 text-[13px] font-semibold text-[#243640] shadow-[0_8px_22px_rgba(46,96,120,0.10)] transition-colors duration-200 hover:bg-white/95"
            >
              Browse workflows
              <ArrowRight className="size-4" />
            </Link>
          }
        />
      ) : (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              label="Awaiting decision"
              value={number(total)}
              tone={total > 0 ? "warning" : "neutral"}
              icon={<Clock3 className="size-4" />}
              sub={
                staleCount > 0
                  ? `${staleCount} of the ${items.length} shown have been blocked over 24 hours`
                  : "Nothing on this page has been blocked a full day"
              }
            />
            <StatTile
              label="Value on this page"
              value={value ? moneyCompact(value.amount, value.currency) : "—"}
              icon={<Coins className="size-4" />}
              sub={
                value
                  ? `Across ${value.counted} priced ${
                      value.counted === 1 ? "order" : "orders"
                    } — none of it committed`
                  : "Not summed: these orders span more than one currency, or none is priced yet"
              }
            />
            <StatTile
              label="Longest wait"
              value={oldest ? relativeTime(oldest.requested_at) : "—"}
              tone={oldestHours !== null && oldestHours >= 24 ? "warning" : "neutral"}
              icon={<AlertTriangle className="size-4" />}
              sub={oldest ? oldest.title || "Untitled request" : undefined}
            />
          </div>

          <ul className="space-y-4">
            {items.map((item) => (
              <QueueCard key={item.id} item={item} />
            ))}
          </ul>

          {total > PAGE_SIZE && (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12.5px] text-[#7e8c94] tnum">
                Showing {number(offset + 1)}–{number(offset + items.length)} of{" "}
                {number(total)}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ChevronLeft className="size-4" />}
                  disabled={offset === 0 || isFetching}
                  onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  iconRight={<ChevronRight className="size-4" />}
                  disabled={offset + PAGE_SIZE >= total || isFetching}
                  onClick={() => setOffset((current) => current + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}

          <p className="mt-6 flex items-start gap-2 text-[11.5px] leading-relaxed text-[#7e8c94]">
            <Wallet className="mt-px size-3.5 shrink-0" />
            Budget figures come from the request the employee typed; order totals
            come from the purchase order the agent generated. Neither is
            re-derived on this screen.
          </p>
        </>
      )}
    </>
  );
}
