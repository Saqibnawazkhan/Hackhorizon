"use client";

/**
 * Screen 17a — the administrator dashboard.
 *
 * The organising idea: of everything on this page, exactly one thing can only
 * be done by the person reading it. The agent plans, quotes, scores, drafts a
 * purchase order and re-drafts it when its own validator rejects it — and then
 * `route_approval` interrupts the graph and stops. A run sitting in the queue
 * below is not "a notification"; it is a state machine parked mid-execution,
 * waiting for a human. So the approval queue gets the widest column and the
 * strongest treatment, and everything else on the page is context around it.
 *
 * Four independent queries rather than one: the dashboard counters, the queue,
 * the vendor monitor's open flags and recent runs each fail and each retry on
 * their own. A slow vendor scan never blanks the approvals list.
 *
 * Two of the four endpoints are admin-only: `/admin/dashboard` and
 * `/admin/flagged-vendors`. `/workflows` and `/approvals` are open to any
 * buyer and simply widen to the whole org for an admin, so a non-admin gets
 * 403 on the counters query alone. That is an answer rather than a fault — it
 * renders as a plain explanation, not a red error.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Gauge,
  History,
  type LucideIcon,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Mono,
  Panel,
  Skeleton,
  StatTile,
  StatusPill,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  VENDOR_STATUS_LABEL,
  VENDOR_STATUS_TONE,
  WORKFLOW_STATUS_LABEL,
  WORKFLOW_STATUS_TONE,
  type Tone,
  dateTime,
  humanise,
  money,
  relativeTime,
} from "@/lib/format";
import type { DashboardStat } from "@/lib/types";

/* --------------------------------------------------------------------------
   The four counters the API ships, each given an icon and a line of context.
   Keyed by `stat.key` so an unfamiliar key still renders, just generically.
   -------------------------------------------------------------------------- */
const STAT_ICON: Record<string, LucideIcon> = {
  active_workflows: Activity,
  pending_approvals: ClipboardCheck,
  completed: CheckCircle2,
  flagged_vendors: ShieldAlert,
};

/**
 * One label the API sends is not true, so it is not rendered.
 *
 * The router hard-codes "Completed this week" for the `completed` counter, but
 * the query behind it (`WorkflowRepository.dashboard_counts`) applies no date
 * predicate at all — it counts every workflow in the COMPLETED state, ever.
 * Printing the API's wording verbatim would put a seven-day window on the
 * screen that nothing measured. Any key without an entry here keeps the label
 * the API sent.
 */
const STAT_LABEL: Record<string, string> = {
  completed: "Completed runs",
};

/**
 * The hints describe what the API actually counts, not what the label implies.
 *
 * `active_workflows` is RUNNING + DRAFT — a run parked at the approval gate is
 * AWAITING_APPROVAL and is counted under `pending_approvals` instead, never
 * both. `completed` is every run that ever reached COMPLETED, with no date
 * window, and the hint says so rather than implying one.
 */
const STAT_HINT: Record<string, string> = {
  active_workflows: "Running now, or drafted and not yet started",
  pending_approvals: "Each one is a graph waiting on you",
  completed: "Every run that has reached the completed state, all time",
  flagged_vendors: "Raised by the reliability monitor",
};

/**
 * `stat.tone` is four strings; the primitive library's `Tone` is six.
 *
 * Mapping rather than casting keeps the narrowing honest in both directions:
 * the compiler checks these four keys are exhaustive against the API type, and
 * a tone the backend grows later lands as `undefined`, which `StatTile` reads
 * as its own "neutral" default instead of indexing the tone tables with a key
 * they do not have and rendering a tile with no colour at all.
 */
const STAT_TONE: Record<DashboardStat["tone"], Tone> = {
  neutral: "neutral",
  positive: "positive",
  warning: "warning",
  danger: "danger",
};

/**
 * `vendor_flags.reason` is one of four values. `humanise` would turn
 * "low_on_time_rate" into "Low on time rate"; these read like English.
 */
const FLAG_REASON_LABEL: Record<string, string> = {
  late_deliveries: "Late deliveries",
  low_on_time_rate: "Low on-time rate",
  cancellations: "Cancellations",
  quantity_shortfall: "Quantity shortfall",
};

export default function AdminDashboardPage() {
  const router = useRouter();

  const dashboard = useQuery({
    queryKey: ["admin", "dashboard"],
    queryFn: () => api.getDashboard(),
  });

  const approvals = useQuery({
    queryKey: ["admin", "approvals", "preview"],
    queryFn: () => api.listApprovals({ limit: 5 }),
  });

  const flagged = useQuery({
    queryKey: ["admin", "flagged-vendors"],
    queryFn: () => api.flaggedVendors(),
  });

  const recent = useQuery({
    queryKey: ["admin", "workflows", "recent"],
    queryFn: () => api.listWorkflows({ limit: 6 }),
  });

  const forbidden =
    dashboard.error instanceof ApiError && dashboard.error.isForbidden;

  // Refresh has to look like it did something even when every query answers
  // from a warm cache in 20 ms, so the button owns the combined fetch state.
  const refreshing =
    dashboard.isFetching ||
    approvals.isFetching ||
    flagged.isFetching ||
    recent.isFetching;

  const refreshAll = () => {
    void dashboard.refetch();
    void approvals.refetch();
    void flagged.refetch();
    void recent.refetch();
  };

  /* ---------------------------------------------------------------------
     403 — the account is signed in and valid, it simply is not an admin.
     --------------------------------------------------------------------- */
  if (forbidden) {
    return (
      <>
        <PageHeader
          title="Administrator dashboard"
          description="Organisation-wide approvals, vendor governance and spend."
        />
        <Card className="max-w-2xl animate-fade-up">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-[16px] bg-[#e9f3f8] text-[#38677b]">
              <ShieldCheck className="size-5" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
                This area requires the administrator role
              </h2>
              <p className="mt-2 text-[13px] leading-relaxed text-[#5f7280]">
                Your session is valid — the approval queue, the vendor monitor
                and the spend report are simply limited to administrators. The
                API enforces that server-side, so the restriction is real rather
                than a hidden menu item.
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-[#5f7280]">
                Ask an administrator to grant the role, or carry on with your own
                requests.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => router.push("/dashboard")}
                  iconRight={<ArrowRight className="size-3.5" />}
                >
                  Back to my workspace
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => router.push("/workflows")}
                >
                  My workflows
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </>
    );
  }

  const data = dashboard.data;
  const pending = data?.pending_approvals ?? 0;
  // `stats` is declared non-optional, but it is assembled by hand in a router
  // returning dict[str, Any] — a list that never arrives must not white-screen
  // the page it is one quarter of.
  const stats = data?.stats ?? [];
  const approvalItems = approvals.data?.items ?? [];
  const flaggedRows = flagged.data ?? [];
  const recentRows = recent.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Administrator dashboard"
        description="Everything the organisation is currently waiting on. The agent runs itself right up to the approval gate — and no further."
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw className="size-3.5" />}
              loading={refreshing}
              onClick={refreshAll}
            >
              {refreshing ? "Refreshing" : "Refresh"}
            </Button>
            <Button
              size="sm"
              onClick={() => router.push("/admin/approvals")}
              iconRight={<ArrowRight className="size-3.5" />}
            >
              Approval queue{pending > 0 ? ` · ${pending}` : ""}
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        {/* ================================================================
            Counters + the headline spend figure
            ================================================================ */}
        {dashboard.error ? (
          <ErrorState
            error={dashboard.error}
            onRetry={() => void dashboard.refetch()}
          />
        ) : (
          <section className="grid gap-4 lg:grid-cols-3">
            <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
              {dashboard.isLoading || !data
                ? Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-[136px] rounded-[28px]" />
                  ))
                : stats.map((stat) => {
                    const Icon = STAT_ICON[stat.key] ?? Gauge;
                    return (
                      <StatTile
                        key={stat.key}
                        label={STAT_LABEL[stat.key] ?? stat.label}
                        value={stat.value}
                        tone={STAT_TONE[stat.tone]}
                        sub={STAT_HINT[stat.key]}
                        icon={<Icon className="size-[18px]" strokeWidth={2} />}
                        className="animate-fade-up"
                      />
                    );
                  })}
            </div>

            {/* The one number everything else adds up to. */}
            {dashboard.isLoading || !data ? (
              <Skeleton className="h-full min-h-[200px] rounded-[28px]" />
            ) : (
              <div className="gradient-hero animate-fade-up relative overflow-hidden rounded-[28px] p-6 text-white shadow-[0_20px_44px_rgba(46,96,120,0.30)]">
                <div
                  className="absolute inset-0 opacity-[0.18]"
                  style={{
                    backgroundImage:
                      "radial-gradient(circle at 18% 10%, rgba(255,255,255,0.9) 0, transparent 46%), radial-gradient(circle at 86% 92%, rgba(185,216,225,0.85) 0, transparent 44%)",
                  }}
                  aria-hidden
                />
                <div className="relative flex h-full flex-col">
                  <div className="flex items-center gap-2.5">
                    <span className="grid size-9 place-items-center rounded-[12px] bg-white/15 backdrop-blur-md">
                      <Wallet className="size-[18px]" strokeWidth={2} />
                    </span>
                    <p className="text-[11px] font-bold uppercase tracking-[0.09em] text-white/70">
                      Total committed spend
                    </p>
                  </div>
                  <p className="tnum mt-6 break-words text-[30px] font-bold leading-none tracking-[-0.03em] sm:text-[34px]">
                    {money(data.total_spend, data.currency)}
                  </p>
                  <p className="mt-3.5 text-[12.5px] leading-relaxed text-white/70">
                    Every purchase order the agent has raised for this
                    organisation, including those still parked at the approval
                    gate.
                  </p>
                  <Link
                    href="/admin/spend"
                    className="mt-auto inline-flex items-center gap-1.5 pt-6 text-[12.5px] font-semibold text-white/90 transition-colors duration-200 hover:text-white"
                  >
                    Break it down by vendor
                    <ArrowRight className="size-3.5" />
                  </Link>
                </div>
              </div>
            )}
          </section>
        )}

        {/* ================================================================
            The centre of the page: what only an admin can clear
            ================================================================ */}
        <section className="grid gap-4 lg:grid-cols-3">
          <Panel
            className="animate-fade-up lg:col-span-2"
            icon={<ClipboardCheck className="size-4" strokeWidth={2.2} />}
            title="Needs your decision"
            description={
              <>
                <Mono>route_approval</Mono> is a hard interrupt. These runs are
                paused mid-execution — nothing is committed, and the agent will
                not approve on its own.
              </>
            }
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => router.push("/admin/approvals")}
                iconRight={<ArrowRight className="size-3.5" />}
              >
                Open queue
              </Button>
            }
            bodyClassName="p-0"
          >
            {approvals.isLoading ? (
              <div className="p-6">
                <LoadingBlock rows={3} />
              </div>
            ) : approvals.error ? (
              <div className="p-6">
                <ErrorState
                  error={approvals.error}
                  onRetry={() => void approvals.refetch()}
                />
              </div>
            ) : approvalItems.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={<CheckCircle2 className="size-6" strokeWidth={1.8} />}
                  title="The queue is clear"
                  description="No workflow is waiting on an approval decision. Anything the agent starts from here will appear the moment it reaches the gate."
                />
              </div>
            ) : (
              <>
                <ul className="divide-y divide-[#eef4f7]">
                  {approvalItems.map((item) => (
                    <li key={item.id}>
                      <Link
                        href={`/admin/approvals/${item.id}`}
                        className="group flex flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4 transition-colors duration-200 hover:bg-white/60"
                      >
                        <span className="grid size-10 shrink-0 place-items-center rounded-[14px] border border-[#fedf89] bg-[#fffaeb] text-[#b54708]">
                          <Clock className="size-[18px]" strokeWidth={2} />
                        </span>

                        <div className="min-w-0 flex-1 basis-[220px]">
                          <p className="truncate text-[13.5px] font-semibold text-[#243640] transition-colors duration-200 group-hover:text-[#38677b]">
                            {item.title || "Untitled request"}
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[#7e8c94]">
                            {item.po_number ? (
                              <Mono>{item.po_number}</Mono>
                            ) : (
                              <span>No PO number yet</span>
                            )}
                            <span aria-hidden>·</span>
                            <span>
                              Budget{" "}
                              {item.budget === null
                                ? "not stated"
                                : money(item.budget, item.currency ?? undefined)}
                            </span>
                            <span aria-hidden>·</span>
                            <span>Requested {relativeTime(item.requested_at)}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-4">
                          <p className="tnum text-right text-[15px] font-bold tracking-[-0.02em] text-[#243640]">
                            {money(item.total_amount, item.currency ?? undefined)}
                          </p>
                          <span className="inline-flex h-9 shrink-0 items-center gap-1 rounded-[12px] border border-[#d6ebf3] bg-[#e9f3f8] px-3.5 text-[12.5px] font-semibold text-[#38677b] transition-colors duration-200 group-hover:bg-[#d6ebf3]">
                            Review
                            <ChevronRight className="size-3.5" />
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
                {(approvals.data?.total ?? 0) > approvalItems.length && (
                  <div className="border-t border-[#eef4f7] px-6 py-3.5">
                    <Link
                      href="/admin/approvals"
                      className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[#447f98] transition-colors duration-200 hover:text-[#38677b]"
                    >
                      {approvals.data?.total} waiting in total — see the full queue
                      <ArrowRight className="size-3.5" />
                    </Link>
                  </div>
                )}
              </>
            )}
          </Panel>

          {/* ---------------------------------------------------------------
              Recent activity — deliberately quiet next to the queue
              --------------------------------------------------------------- */}
          <Panel
            className="animate-fade-up"
            icon={<History className="size-4" strokeWidth={2.2} />}
            title="Recent activity"
            description="The six most recent runs."
            actions={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => router.push("/workflows")}
              >
                All
              </Button>
            }
            bodyClassName="p-0"
          >
            {recent.isLoading ? (
              <div className="p-6">
                <LoadingBlock rows={3} />
              </div>
            ) : recent.error ? (
              <div className="p-6">
                <ErrorState
                  error={recent.error}
                  onRetry={() => void recent.refetch()}
                />
              </div>
            ) : recentRows.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={<History className="size-6" strokeWidth={1.8} />}
                  title="Nothing has run yet"
                  description="Workflows appear here as soon as anyone submits a request."
                />
              </div>
            ) : (
              <ul className="divide-y divide-[#eef4f7]">
                {recentRows.map((workflow) => (
                  <li key={workflow.id}>
                    <Link
                      href={`/workflows/${workflow.id}`}
                      className="group block px-6 py-3.5 transition-colors duration-200 hover:bg-white/60"
                    >
                      <p className="truncate text-[13px] font-semibold text-[#243640] transition-colors duration-200 group-hover:text-[#38677b]">
                        {workflow.title || "Untitled request"}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[#7e8c94]">
                        <StatusPill
                          size="sm"
                          label={WORKFLOW_STATUS_LABEL[workflow.status]}
                          tone={WORKFLOW_STATUS_TONE[workflow.status]}
                        />
                        <span className="tnum">
                          {money(workflow.total_amount, workflow.currency)}
                        </span>
                        <span aria-hidden>·</span>
                        <span>{relativeTime(workflow.created_at)}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>

        {/* ================================================================
            Vendor monitor
            ================================================================ */}
        <Panel
          className="animate-fade-up"
          icon={<ShieldAlert className="size-4" strokeWidth={2.2} />}
          title="Flagged vendors"
          description="A background monitor reads real fulfilment history — late deliveries, cancellations, quantity accuracy — and raises a flag when a vendor crosses a configured threshold. A flag is a warning, not a ban: the agent still quotes a flagged vendor and says so in its justification, leaving the call to you."
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => router.push("/admin/vendors")}
              iconRight={<ArrowRight className="size-3.5" />}
            >
              Vendor governance
            </Button>
          }
        >
          {flagged.isLoading ? (
            <LoadingBlock rows={2} />
          ) : flagged.error ? (
            <ErrorState
              error={flagged.error}
              onRetry={() => void flagged.refetch()}
            />
          ) : flaggedRows.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck className="size-6" strokeWidth={1.8} />}
              title="No vendor is flagged"
              description="Every supplier with enough fulfilment history sits inside its configured reliability thresholds."
            />
          ) : (
            <Table minWidth={780}>
              <thead>
                <tr>
                  <Th>Vendor</Th>
                  <Th>Reason</Th>
                  <Th>What the monitor saw</Th>
                  <Th>Threshold</Th>
                  <Th align="right">Raised</Th>
                </tr>
              </thead>
              <tbody>
                {flaggedRows.map((flag) => (
                  // One monitor pass can raise several flags against the same
                  // vendor inside one transaction, and `raised_at` defaults to
                  // now() — which Postgres holds constant for the whole
                  // transaction. vendor + timestamp alone is therefore not
                  // unique; the reason is what separates them.
                  <Tr
                    key={`${flag.vendor_id}-${flag.reason}-${flag.raised_at}`}
                    onClick={() => router.push("/admin/vendors")}
                  >
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <span className="truncate font-semibold">
                          {flag.vendor_name}
                        </span>
                        <StatusPill
                          size="sm"
                          label={VENDOR_STATUS_LABEL[flag.vendor_status]}
                          tone={VENDOR_STATUS_TONE[flag.vendor_status]}
                        />
                      </div>
                    </Td>
                    <Td>
                      <span className="text-[#b42318]">
                        {FLAG_REASON_LABEL[flag.reason] ?? humanise(flag.reason)}
                      </span>
                    </Td>
                    <Td className="text-[#5f7280]">{flag.detail}</Td>
                    <Td>
                      <Mono>{flag.threshold}</Mono>
                    </Td>
                    <Td align="right" className="text-[12.5px] text-[#7e8c94]">
                      {relativeTime(flag.raised_at)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        {data && (
          <p className="px-1 text-[12px] text-[#7e8c94]">
            Figures generated {dateTime(data.generated_at)} ·{" "}
            {relativeTime(data.generated_at)}. Refresh to recount.
          </p>
        )}
      </div>
    </>
  );
}
