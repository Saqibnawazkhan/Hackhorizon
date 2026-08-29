"use client";

/**
 * The employee home.
 *
 * A requester lands here to do one of two things: start something, or find
 * out where something already running has got to. So the screen is a hero
 * that takes a sentence of plain English, a row of counts, the last eight
 * runs, and — because this product's whole claim is that the agent's
 * reasoning is visible — a compact map of the graph every run walks,
 * including the two edges that matter: the self-correction loop back to
 * generate_po, and the approval interrupt no agent can pass on its own.
 *
 * The four counts are four separate queries rather than one aggregate: the
 * list endpoint already returns `total` alongside a one-row page, so asking
 * for `limit: 1` is the cheapest honest count available to an employee. The
 * admin dashboard endpoint would be a 403 here.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  ChevronRight,
  CircleCheck,
  ClipboardCheck,
  History,
  Lock,
  type LucideIcon,
  Receipt,
  RefreshCw,
  RotateCcw,
  Scale,
  Send,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  SquarePen,
  Store,
} from "lucide-react";
import Link from "next/link";
import { useMemo, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Button,
  EmptyState,
  ErrorState,
  Panel,
  Skeleton,
  StatTile,
  StatusPill,
  cn,
  useToast,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  WORKFLOW_STATUS_LABEL,
  WORKFLOW_STATUS_TONE,
  money,
  number,
  relativeTime,
  type Tone,
} from "@/lib/format";
import type { WorkflowType } from "@/lib/types";

/* ==========================================================================
   Static copy
   ========================================================================== */

/** The three requests the planner is demonstrated on, verbatim. */
const EXAMPLES: { label: string; text: string }[] = [
  {
    label: "Multi-supplier procurement",
    text:
      "Create a purchase request for 50 laptops under PKR 10 million, compare three suppliers, identify the best option, prepare the purchase order, and send it for approval.",
  },
  {
    label: "Conversational restock",
    text:
      "We're out of monitors again. Grab 25 of the 27-inch ones, keep it under two million rupees, and route it to Imran.",
  },
  {
    label: "Expense reimbursement",
    text:
      "I need to claim back PKR 85,000 for my Karachi client visit — hotel, flights and meals.",
  },
];

const HERO_POINTS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: SquarePen,
    title: "It plans before it acts",
    body: "Claude reads the sentence, works out whether it is procurement or reimbursement, and shows you the steps. Nothing runs until you confirm.",
  },
  {
    icon: Scale,
    title: "It scores, it does not guess",
    body: "Suppliers are weighed on price, delivery, warranty and reliability, with the arithmetic and the data confidence on show.",
  },
  {
    icon: ShieldCheck,
    title: "It stops for a person",
    body: "Every run halts before anything is committed. An administrator approves or rejects it.",
  },
];

const TYPE_META: Record<WorkflowType, { label: string; icon: LucideIcon }> = {
  procurement: { label: "Procurement", icon: ShoppingCart },
  reimbursement: { label: "Reimbursement", icon: Receipt },
};

/** The procurement graph in execution order. Names match the LangGraph nodes. */
const RUN_NODES: { name: string; title: string; accent?: "loop" | "gate" }[] = [
  { name: "create_request", title: "Create request" },
  { name: "fetch_quotes", title: "Fetch quotes" },
  { name: "budget_filter", title: "Filter by budget" },
  { name: "score_rank", title: "Score and rank" },
  { name: "select_best", title: "Select best option" },
  { name: "generate_po", title: "Generate PO" },
  { name: "validate_po", title: "Validate PO", accent: "loop" },
  { name: "route_approval", title: "Route for approval", accent: "gate" },
];

function greetingFor(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function promptHref(text: string): string {
  return `/requests/new?prompt=${encodeURIComponent(text)}`;
}

/* ==========================================================================
   Page
   ========================================================================== */
export default function DashboardPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const recent = useQuery({
    queryKey: ["dashboard", "recent-workflows"],
    queryFn: () => api.listWorkflows({ limit: 8 }),
  });

  const running = useQuery({
    queryKey: ["dashboard", "count", "running"],
    queryFn: () => api.listWorkflows({ status: "running", limit: 1 }),
  });

  const awaiting = useQuery({
    queryKey: ["dashboard", "count", "awaiting_approval"],
    queryFn: () => api.listWorkflows({ status: "awaiting_approval", limit: 1 }),
  });

  const vendors = useQuery({
    queryKey: ["dashboard", "count", "vendors"],
    queryFn: () => api.listVendors({ limit: 1 }),
  });

  const firstName = useMemo(() => {
    const name = user?.fullName ?? user?.email?.split("@")[0] ?? null;
    if (!name) return "there";
    // A whitespace-only display name would otherwise render "Good morning, ."
    return name.trim().split(/\s+/)[0] || "there";
  }, [user?.fullName, user?.email]);

  const greeting = useMemo(() => greetingFor(new Date().getHours()), []);

  const items = recent.data?.items ?? [];
  const completedRecently = items.filter((w) => w.status === "completed").length;
  const refreshing =
    recent.isFetching ||
    running.isFetching ||
    awaiting.isFetching ||
    vendors.isFetching;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Where your requests stand, and what the agent is doing about them right now."
        actions={
          <Button
            size="sm"
            variant="secondary"
            icon={
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            }
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
              toast("Refreshed.");
            }}
          >
            Refresh
          </Button>
        }
      />

      <div className="space-y-6">
        {/* ================================================================
            1 — Hero. Dark panel, white type. The composer is the point of
            the screen, so it gets the widest line on the page.
            ================================================================ */}
        <section className="gradient-hero animate-fade-up relative overflow-hidden rounded-[28px] shadow-[0_20px_44px_rgba(46,96,120,0.24)]">
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.18]"
            style={{
              backgroundImage:
                "radial-gradient(circle at 14% 10%, rgba(255,255,255,0.95) 0, transparent 44%), radial-gradient(circle at 84% 88%, rgba(185,216,225,0.9) 0, transparent 46%)",
            }}
            aria-hidden
          />
          <div className="relative z-10 p-6 sm:p-9 lg:p-10">
            <div className="grid gap-9 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-12">
              <div className="min-w-0">
                <p className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-white/75 backdrop-blur-md">
                  <Sparkles className="size-3.5" strokeWidth={2.2} />
                  Workflow console
                </p>

                <h2 className="mt-5 text-[30px] font-bold leading-[1.1] tracking-[-0.035em] text-white sm:text-[36px]">
                  {greeting}, {firstName}.
                </h2>
                <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-white/70">
                  Describe a purchase or a claim the way you would say it out
                  loud. The agent works out what kind of workflow it is, sources
                  and scores the options, drafts the paperwork, checks its own
                  output — and then waits for a human to approve it.
                </p>

                {/* Composer-style CTA */}
                <Link
                  href="/requests/new"
                  className="group mt-7 flex flex-col gap-3 rounded-[22px] border border-white/25 bg-white/10 p-3 backdrop-blur-md transition-all duration-200 hover:border-white/45 hover:bg-white/[0.17] sm:flex-row sm:items-center sm:gap-4 sm:p-2.5 sm:pl-5"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <Send className="size-[18px] shrink-0 text-white/60" />
                    <span className="min-w-0 truncate text-[13.5px] text-white/60">
                      Describe what you need in plain English…
                    </span>
                  </span>
                  <span className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-[16px] bg-white px-5 text-[13.5px] font-semibold tracking-[-0.01em] text-[#27485a] shadow-[0_12px_26px_rgba(16,40,52,0.28)] transition-transform duration-200 group-hover:-translate-y-px">
                    Start a request
                    <ArrowRight className="size-4" />
                  </span>
                </Link>
              </div>

              <ul className="space-y-5 lg:pt-2">
                {HERO_POINTS.map((point) => {
                  const Icon = point.icon;
                  return (
                    <li key={point.title} className="flex gap-3.5">
                      <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[13px] border border-white/20 bg-white/[0.12] text-white/85 backdrop-blur-md">
                        <Icon className="size-[17px]" strokeWidth={2} />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[13.5px] font-semibold text-white">
                          {point.title}
                        </p>
                        <p className="mt-0.5 text-[12.5px] leading-relaxed text-white/60">
                          {point.body}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Example prompts */}
            <div className="mt-9 border-t border-white/15 pt-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-white/50">
                Or start from an example
              </p>
              <div className="mt-3.5 grid gap-3 sm:grid-cols-3">
                {EXAMPLES.map((example) => (
                  <Link
                    key={example.label}
                    href={promptHref(example.text)}
                    className="group flex flex-col rounded-[18px] border border-white/20 bg-white/[0.08] p-4 text-left backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:border-white/40 hover:bg-white/[0.16]"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-white/55">
                        {example.label}
                      </span>
                      <ArrowRight className="size-3.5 shrink-0 text-white/40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white/80" />
                    </span>
                    <span className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-white/80">
                      {example.text}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ================================================================
            2 — Counts
            ================================================================ */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <CountTile
            href="/workflows"
            label="In flight"
            value={number(running.data?.total)}
            sub="Executing right now"
            tone="brand"
            icon={<Activity className="size-[18px]" />}
            loading={running.isLoading}
            failed={Boolean(running.error)}
          />
          <CountTile
            href="/workflows"
            label="Awaiting approval"
            value={number(awaiting.data?.total)}
            sub="Held at the human gate"
            tone="warning"
            icon={<ClipboardCheck className="size-[18px]" />}
            loading={awaiting.isLoading}
            failed={Boolean(awaiting.error)}
          />
          <CountTile
            href="/workflows"
            label="Completed"
            value={number(completedRecently)}
            sub="Of your eight most recent runs"
            tone="positive"
            icon={<CircleCheck className="size-[18px]" />}
            loading={recent.isLoading}
            failed={Boolean(recent.error)}
          />
          <CountTile
            href="/vendors"
            label="Vendors on file"
            value={number(vendors.data?.total)}
            sub="Suppliers the agent can quote from"
            tone="neutral"
            icon={<Store className="size-[18px]" />}
            loading={vendors.isLoading}
            failed={Boolean(vendors.error)}
          />
        </div>

        {/* ================================================================
            3 — Recent workflows
            ================================================================ */}
        <Panel
          icon={<History className="size-[18px]" />}
          title="Recent workflows"
          description="The last eight requests you can see, newest first."
          bodyClassName={items.length > 0 ? "p-2.5 sm:p-3" : undefined}
          actions={
            <Link
              href="/workflows"
              className="inline-flex items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-[12.5px] font-semibold text-[#447f98] transition-colors duration-200 hover:bg-white/70 hover:text-[#38677b]"
            >
              View all
              <ArrowRight className="size-3.5" />
            </Link>
          }
        >
          {recent.isLoading ? (
            <div className="space-y-2 p-1">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-[62px]" />
              ))}
            </div>
          ) : recent.error ? (
            <ErrorState error={recent.error} onRetry={() => void recent.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Send className="size-6" />}
              title="Nothing has run yet"
              description="Your first request is one sentence. Describe what you need and the agent drafts a plan for you to confirm before it commits anything."
              action={
                <Link href="/requests/new">
                  <Button icon={<Sparkles className="size-4" />}>
                    Start your first request
                  </Button>
                </Link>
              }
            />
          ) : (
            <ul className="space-y-0.5">
              {items.map((workflow) => {
                const meta = TYPE_META[workflow.workflow_type];
                const TypeIcon = meta?.icon ?? ShoppingCart;
                return (
                  <li key={workflow.id}>
                    <Link
                      href={`/workflows/${workflow.id}`}
                      className="group flex flex-col gap-2.5 rounded-[18px] px-3 py-3 transition-colors duration-200 hover:bg-white/70 sm:flex-row sm:items-center sm:gap-4"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-[#e9f3f8] text-[#447f98] transition-colors duration-200 group-hover:bg-[#d6ebf3]">
                          <TypeIcon className="size-[17px]" strokeWidth={2} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13.5px] font-semibold tracking-[-0.01em] text-[#243640]">
                            {workflow.title}
                          </span>
                          <span className="mt-0.5 block truncate text-[11.5px] text-[#7e8c94]">
                            {meta?.label ?? "Workflow"} ·{" "}
                            {relativeTime(workflow.created_at)}
                          </span>
                        </span>
                      </span>

                      <span className="flex items-center justify-between gap-3 pl-12 sm:justify-end sm:pl-0">
                        <span className="tnum text-[13px] font-semibold text-[#243640] sm:min-w-[140px] sm:text-right">
                          {money(workflow.total_amount, workflow.currency)}
                        </span>
                        <StatusPill
                          label={WORKFLOW_STATUS_LABEL[workflow.status]}
                          tone={WORKFLOW_STATUS_TONE[workflow.status]}
                          size="sm"
                        />
                        <ChevronRight className="hidden size-4 shrink-0 text-[#b3c4cc] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-[#447f98] sm:block" />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {/* ================================================================
            4 — The graph, and the two edges that are not straight lines
            ================================================================ */}
        <Panel
          icon={<Activity className="size-[18px]" />}
          title="How a run works"
          description="Eight nodes, executed in order by a LangGraph state machine. Two of them do something other than move forward."
        >
          {/* overflow-x-auto also computes overflow-y to auto, so the bracket
              markers below need real bottom clearance or they get clipped. */}
          <div className="-mx-1 overflow-x-auto px-1 pb-4">
            <div className="min-w-[880px]">
              <div className="grid grid-cols-8 gap-2">
                {RUN_NODES.map((node, index) => (
                  <div key={node.name} className="relative">
                    <div
                      className={cn(
                        "h-full rounded-[16px] border px-3 py-3 transition-colors duration-200",
                        node.accent === "gate"
                          ? "gradient-cta border-transparent text-white shadow-[0_10px_22px_rgba(46,96,120,0.30)]"
                          : node.accent === "loop"
                            ? "border-[#fedf89] bg-[#fffaeb]"
                            : "border-[#e3ebef] bg-white/70",
                      )}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span
                          className={cn(
                            "tnum text-[10px] font-bold",
                            node.accent === "gate"
                              ? "text-white/70"
                              : "text-[#a3b6c0]",
                          )}
                        >
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        {node.accent === "gate" && (
                          <Lock className="size-3.5 text-white/80" strokeWidth={2.2} />
                        )}
                        {node.accent === "loop" && (
                          <RotateCcw
                            className="size-3.5 text-[#b54708]"
                            strokeWidth={2.2}
                          />
                        )}
                      </div>
                      <p
                        className={cn(
                          "mt-2 text-[11.5px] font-semibold leading-tight",
                          node.accent === "gate"
                            ? "text-white"
                            : node.accent === "loop"
                              ? "text-[#b54708]"
                              : "text-[#243640]",
                        )}
                      >
                        {node.title}
                      </p>
                      <p
                        className={cn(
                          "mt-1 truncate font-mono text-[9.5px]",
                          node.accent === "gate"
                            ? "text-white/55"
                            : "text-[#a3b6c0]",
                        )}
                      >
                        {node.name}
                      </p>
                    </div>
                    {index < RUN_NODES.length - 1 && (
                      <ChevronRight
                        className="absolute -right-[11px] top-1/2 z-10 size-3.5 -translate-y-1/2 text-[#b9d8e1]"
                        strokeWidth={2.5}
                        aria-hidden
                      />
                    )}
                  </div>
                ))}
              </div>

              {/* The loop bracket sits under nodes 6–7; the gate marker under 8. */}
              <div className="mt-1.5 grid grid-cols-8 gap-2">
                <div className="relative col-start-6 col-end-8">
                  <div className="h-6 rounded-b-[14px] border-x border-b border-dashed border-[#fedf89]" />
                  <span className="absolute -bottom-2.5 left-1/2 grid size-5 -translate-x-1/2 place-items-center rounded-full border border-[#fedf89] bg-[#fffaeb] text-[#b54708]">
                    <RotateCcw className="size-3" strokeWidth={2.4} />
                  </span>
                </div>
                <div className="relative col-start-8">
                  <div className="h-6 rounded-b-[14px] border-x border-b border-dashed border-[#b9d8e1]" />
                  <span className="absolute -bottom-2.5 left-1/2 grid size-5 -translate-x-1/2 place-items-center rounded-full border border-[#b9d8e1] bg-[#d6ebf3] text-[#38677b]">
                    <Lock className="size-3" strokeWidth={2.4} />
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 grid gap-3 lg:grid-cols-2">
            <div className="glass-flat flex gap-3.5 rounded-[18px] p-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-[#fffaeb] text-[#b54708]">
                <RotateCcw className="size-[17px]" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold text-[#243640]">
                  Validate PO can send the run backwards
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-[#5f7280]">
                  When a check fails — budget, quantities, supplier consistency
                  — the graph returns to Generate PO and rebuilds it. Those
                  attempts are budgeted. If the budget runs out, or no supplier
                  qualified in the first place, the run escalates to a person
                  rather than guessing.
                </p>
              </div>
            </div>

            <div className="glass-flat flex gap-3.5 rounded-[18px] p-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-[#d6ebf3] text-[#38677b]">
                <ShieldCheck className="size-[17px]" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold text-[#243640]">
                  Route for approval is a hard stop
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-[#5f7280]">
                  The state machine interrupts here and holds. An administrator
                  approves or rejects before a single purchase order is
                  committed, and only that decision resumes the graph. The agent
                  never approves its own work.
                </p>
              </div>
            </div>
          </div>

          <p className="mt-4 text-[11.5px] leading-relaxed text-[#7e8c94]">
            This is the procurement path. A reimbursement claim runs a six-node
            policy path through the same engine — a workflow type is
            configuration, not code.
          </p>
        </Panel>
      </div>
    </>
  );
}

/* ==========================================================================
   A stat tile that is also a link. Local to this screen.
   ========================================================================== */
function CountTile({
  href,
  label,
  value,
  sub,
  tone,
  icon,
  loading,
  failed,
}: {
  href: string;
  label: string;
  value: string;
  sub: string;
  tone: Tone;
  icon: ReactNode;
  loading: boolean;
  failed: boolean;
}) {
  if (loading) {
    return <Skeleton className="h-[122px] rounded-[28px]" />;
  }
  return (
    <Link
      href={href}
      className="block rounded-[28px] transition-transform duration-200 hover:-translate-y-0.5"
    >
      <StatTile
        label={label}
        value={failed ? "—" : value}
        sub={failed ? "Count unavailable right now" : sub}
        tone={failed ? "muted" : tone}
        icon={icon}
        className="h-full"
      />
    </Link>
  );
}
