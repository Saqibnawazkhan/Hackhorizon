"use client";

/**
 * The request composer — design screens 2a → 3a.
 *
 * One route, three stages, all held in local state:
 *
 *   compose   a free-text box and nothing else. No type selector, no category
 *             picker, no budget field — `POST /workflows` accepts request text
 *             and an idempotency key, and refuses a workflow_type hint. The
 *             absence of those controls is the product claim, so the screen
 *             says why they are missing rather than quietly omitting them.
 *   planning  Claude is drafting, which takes seconds. The wait shows the
 *             shape of what is coming — a ghosted plan on its rail — instead
 *             of a spinner that says nothing.
 *   review    the returned plan, the entities it extracted, and the two
 *             buttons that decide whether any of it actually happens.
 *
 * Nothing executes here. Creating a workflow writes a draft and returns a
 * plan; only `POST /workflows/{id}/run` starts the graph. That gap is the
 * whole argument of the product, so the review stage states it plainly and
 * the confirm button is the only thing that closes it.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CornerDownLeft,
  ListChecks,
  PauseCircle,
  Receipt,
  RefreshCw,
  Send,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Button,
  Card,
  CopyButton,
  DetailList,
  EmptyState,
  Mono,
  Panel,
  Skeleton,
  StatusPill,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
  cn,
  useToast,
} from "@/components/ui";
import { PlanPreview } from "@/components/workflow/ExecutionTimeline";
import { ApiError, api } from "@/lib/api";
import {
  WORKFLOW_STATUS_LABEL,
  WORKFLOW_STATUS_TONE,
  humanise,
  money,
  number as formatNumber,
} from "@/lib/format";
import type { PlannedStep, WorkflowPlanResponse } from "@/lib/types";

/* ==========================================================================
   Constants — the API's own limits, mirrored so the button can lead the 422
   ========================================================================== */
const MIN_CHARS = 8;
const MAX_CHARS = 4000;

/**
 * Three starting points. Deliberately unlabelled by type: none of them tells
 * the agent which workflow it is, which is exactly the point being made.
 */
const EXAMPLES: { label: string; text: string }[] = [
  {
    label: "Fifty laptops",
    text:
      "Create a purchase request for 50 laptops under PKR 10 million, compare " +
      "three suppliers, identify the best option, prepare the purchase order, " +
      "and send it for approval.",
  },
  {
    label: "Monitors and docks",
    text:
      "We need 30 27-inch monitors and 30 USB-C docking stations for the new " +
      "floor, delivered within two weeks, budget PKR 4.5 million. Priya should " +
      "approve it.",
  },
  {
    label: "Expense claim",
    text:
      "I need to claim back PKR 85,000 for my Karachi client visit last week — " +
      "two nights hotel, flights and meals. Receipts attached.",
  },
];

/** What the planner is actually doing while the request is in flight. */
const PLANNING_PHASES = [
  "Reading your request…",
  "Inferring the workflow type from the wording…",
  "Extracting items, quantities, budget and approver…",
  "Drafting the execution plan…",
  "Validating the plan against its schema…",
];

/** Deterministic ghost widths — a random layout would flicker on re-render. */
const GHOST_ROWS = [70, 54, 64, 48, 60, 44, 68, 52];

/**
 * A key identifying one composition attempt.
 *
 * Not `crypto.randomUUID()`: that is a secure-context API and is undefined
 * when the console is served over plain http on a LAN, which is exactly the
 * situation a demo runs in.
 */
function newIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type Stage = "compose" | "planning" | "review";

const STAGE_TRAIL: { key: Stage; label: string }[] = [
  { key: "compose", label: "Describe" },
  { key: "planning", label: "Plan" },
  { key: "review", label: "Confirm" },
];

/* ==========================================================================
   Page
   ========================================================================== */
export default function NewRequestPage() {
  // useSearchParams() opts the subtree into client-side bailout, which Next 15
  // requires a Suspense boundary for.
  return (
    <Suspense fallback={<ComposerFallback />}>
      <NewRequestInner />
    </Suspense>
  );
}

function ComposerFallback() {
  return (
    <>
      <PageHeader
        title="New request"
        description="Describe what you need in plain English. The agent plans it before anything runs."
      />
      <div className="mx-auto w-full max-w-[880px] space-y-4">
        <Skeleton className="h-[300px] rounded-[28px]" />
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-[130px] rounded-[24px]" />
          ))}
        </div>
      </div>
    </>
  );
}

function NewRequestInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // One key per wording. Retrying after a failure that may have committed
  // server-side then returns the same draft instead of writing a second one.
  const attemptRef = useRef<{ text: string; key: string } | null>(null);

  // A ?prompt= from the dashboard's quick-start tiles seeds the box once.
  const [text, setText] = useState(() => searchParams.get("prompt") ?? "");
  const [plan, setPlan] = useState<WorkflowPlanResponse | null>(null);

  const trimmed = text.trim();
  const length = trimmed.length;
  const tooShort = length < MIN_CHARS;
  const tooLong = length > MAX_CHARS;

  /**
   * Stable while the wording is, fresh once it changes. Retrying the same text
   * replays the draft the server already wrote; rewording writes a new one.
   */
  const idempotencyKeyFor = (requestText: string) => {
    if (attemptRef.current?.text !== requestText) {
      attemptRef.current = { text: requestText, key: newIdempotencyKey() };
    }
    return attemptRef.current.key;
  };

  const planMutation = useMutation({
    mutationFn: (requestText: string) =>
      api.createWorkflow(requestText, idempotencyKeyFor(requestText)),
    onSuccess: (response) => {
      setPlan(response);
      // The draft is already a row in the history list.
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
  });

  const runMutation = useMutation({
    mutationFn: (workflowId: string) => api.runWorkflow(workflowId),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      toast("Execution started — following it live.");
      router.push(`/workflows/${response.workflow_id}`);
    },
  });

  const stage: Stage = plan
    ? "review"
    : planMutation.isPending
      ? "planning"
      : "compose";

  const phase = usePlanningPhase(stage === "planning");

  const submit = () => {
    if (tooShort || tooLong || planMutation.isPending) return;
    planMutation.mutate(trimmed);
  };

  const confirm = () => {
    if (!plan || runMutation.isPending) return;
    runMutation.mutate(plan.workflow_id);
  };

  /** Discard returns to the composer with the original wording intact. */
  const discard = () => {
    setPlan(null);
    planMutation.reset();
    runMutation.reset();
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const applyExample = (value: string) => {
    setText(value);
    planMutation.reset();
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    requestAnimationFrame(() => element.setSelectionRange(value.length, value.length));
  };

  return (
    <>
      <PageHeader
        breadcrumb={<StageTrail stage={stage} />}
        title={stage === "review" ? "Confirm the plan" : "New request"}
        description={
          stage === "review"
            ? "Read what the agent understood and how it intends to proceed. Nothing has executed, and nothing will until you confirm."
            : "Describe what you need in plain English. The agent turns it into an explicit plan and waits for you to approve that plan before it runs."
        }
        actions={
          plan ? (
            <StatusPill
              label={WORKFLOW_STATUS_LABEL[plan.status]}
              tone={WORKFLOW_STATUS_TONE[plan.status]}
            />
          ) : undefined
        }
      />

      {/* ------------------------------------------------------------------
          STAGE 1 — compose
          ------------------------------------------------------------------ */}
      {stage === "compose" && (
        <div className="mx-auto w-full max-w-[880px]">
          {planMutation.isError && (
            <RequestError
              error={planMutation.error}
              onRetry={submit}
              className="animate-fade-up mb-4"
            />
          )}

          <Card className="animate-fade-up p-5 sm:p-7">
            <div className="flex items-start gap-3">
              <span className="gradient-avatar grid size-9 shrink-0 place-items-center rounded-full text-white shadow-[0_6px_16px_rgba(46,96,120,0.24)]">
                <Sparkles className="size-4" strokeWidth={2.2} />
              </span>
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold text-[#243640]">
                  What do you need?
                </p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-[#7e8c94]">
                  Quantities, budgets, deadlines and approvers are all picked up
                  if you mention them. Leave one out and the agent will say so
                  rather than invent it.
                </p>
              </div>
            </div>

            <Textarea
              ref={textareaRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              invalid={tooLong}
              aria-label="Your request, in plain English"
              placeholder="e.g. Create a purchase request for 50 laptops under PKR 10 million, compare three suppliers, and send the best one for approval."
              className="mt-4 min-h-[160px] text-[15px] leading-[1.65]"
            />

            <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
              <p
                className={cn(
                  "text-[11.5px] tnum",
                  tooLong ? "font-semibold text-[#b42318]" : "text-[#7e8c94]",
                )}
              >
                <span className="font-semibold">{formatNumber(length)}</span>
                <span className="text-[#a9bac3]"> / {formatNumber(MAX_CHARS)}</span>
                {tooLong ? (
                  <span> · {formatNumber(length - MAX_CHARS)} over the limit</span>
                ) : tooShort && length > 0 ? (
                  <span className="text-[#b54708]">
                    {" "}
                    · {MIN_CHARS - length} more character
                    {MIN_CHARS - length === 1 ? "" : "s"} needed
                  </span>
                ) : null}
              </p>

              <div className="flex items-center gap-3">
                <span className="hidden items-center gap-1.5 text-[11.5px] text-[#a3b6c0] sm:inline-flex">
                  <CornerDownLeft className="size-3.5" />
                  Ctrl / ⌘ + Enter
                </span>
                <Button
                  size="lg"
                  icon={<Send className="size-4" />}
                  disabled={tooShort || tooLong}
                  onClick={submit}
                >
                  Draft the plan
                </Button>
              </div>
            </div>
          </Card>

          <div className="mt-3.5 flex items-start gap-2.5 px-1">
            <Wand2 className="mt-0.5 size-3.5 shrink-0 text-[#93a7b1]" />
            <p className="max-w-[70ch] text-[12px] leading-relaxed text-[#7e8c94]">
              Free text is the entire input. There is no type selector on this
              screen because the API refuses one — the planner decides whether
              this is a procurement or a reimbursement from your words alone,
              and you will see that inference, and every step it implies, before
              anything runs.
            </p>
          </div>

          {/* Examples ---------------------------------------------------- */}
          <div className="mt-9">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#a3b6c0]">
              Start from an example
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {EXAMPLES.map((example, index) => (
                <button
                  key={example.label}
                  type="button"
                  onClick={() => applyExample(example.text)}
                  className="glass-flat animate-fade-up group rounded-[24px] p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/90 hover:shadow-[0_16px_32px_rgba(46,96,120,0.14)]"
                  style={{ animationDelay: `${100 + index * 70}ms` }}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#447f98]">
                    {example.label}
                  </p>
                  <p className="mt-2 line-clamp-4 text-[12.5px] leading-relaxed text-[#5f7280]">
                    {example.text}
                  </p>
                  <span className="mt-3 inline-flex items-center gap-1 text-[11.5px] font-semibold text-[#93a7b1] transition-colors group-hover:text-[#447f98]">
                    Use this
                    <ArrowRight className="size-3" />
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-3 px-1 text-[12px] text-[#7e8c94]">
              Two of these are purchases and one is an expense claim, but none of
              them says so. Watch which type comes back.
            </p>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------
          STAGE 1.5 — planning. A ghosted plan, not a spinner.
          ------------------------------------------------------------------ */}
      {stage === "planning" && (
        <div className="mx-auto w-full max-w-[880px] space-y-4">
          <RequestBubble text={trimmed} />

          <Card className="animate-fade-up p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-3">
              <span className="animate-pulse-ring gradient-avatar grid size-9 shrink-0 place-items-center rounded-full text-white">
                <Sparkles className="size-4" strokeWidth={2.2} />
              </span>
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold text-[#243640]">
                  Claude is drafting a plan
                </p>
                <p className="mt-0.5 text-[12.5px] text-[#5f7280]">
                  {PLANNING_PHASES[phase]}
                </p>
              </div>
              <span className="ml-auto shrink-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#a3b6c0]">
                Nothing is running
              </span>
            </div>

            <ol className="mt-6 space-y-1" aria-hidden>
              {GHOST_ROWS.map((width, index) => (
                <li key={index} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <Skeleton className="size-8 rounded-full" />
                    {index < GHOST_ROWS.length - 1 && (
                      <span
                        className="w-0.5 flex-1 rounded-full bg-[#e0ebf0]"
                        style={{ minHeight: 14 }}
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 pb-4">
                    <div style={{ width: `${width}%` }}>
                      <Skeleton className="h-3.5 rounded-full" />
                    </div>
                    <div className="mt-2" style={{ width: `${Math.min(width + 18, 92)}%` }}>
                      <Skeleton className="h-2.5 rounded-full" />
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      )}

      {/* ------------------------------------------------------------------
          STAGE 2 — review the plan
          ------------------------------------------------------------------ */}
      {stage === "review" && plan && (
        <div className="space-y-5">
          <Alert
            tone="brand"
            icon={<PauseCircle className="size-4" />}
            title="Nothing has run yet"
            className="animate-fade-up"
          >
            This is a draft. No supplier has been contacted, no quote fetched, no
            purchase order written and nothing committed. Execution begins only
            when you confirm below — and even then it stops again at an
            administrator&rsquo;s approval before anything is issued.
          </Alert>

          <div className="grid gap-5 lg:grid-cols-12">
            {/* --- Main column: the agent speaking, then its plan --------- */}
            <div className="space-y-4 lg:col-span-7 xl:col-span-8">
              <RequestBubble text={trimmed} />

              <div
                className="animate-fade-up flex gap-3"
                style={{ animationDelay: "60ms" }}
              >
                <span className="gradient-avatar mt-1 grid size-8 shrink-0 place-items-center rounded-full text-white shadow-[0_6px_16px_rgba(46,96,120,0.24)]">
                  <Sparkles className="size-3.5" strokeWidth={2.2} />
                </span>
                <div className="glass min-w-0 flex-1 rounded-[24px] rounded-tl-[8px] p-5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#a3b6c0]">
                    What I understood
                  </p>
                  <p className="mt-2 text-[15px] leading-[1.6] text-[#243640]">
                    {plan.summary}
                  </p>
                </div>
              </div>

              <div className="animate-fade-up" style={{ animationDelay: "130ms" }}>
                <Panel
                  title="Execution plan"
                  description={
                    plan.plan.length > 0
                      ? `${plan.plan.length} steps, in the order the graph will take them`
                      : "The planner returned no steps"
                  }
                  icon={<ListChecks className="size-4" />}
                >
                  {plan.plan.length === 0 ? (
                    <EmptyState
                      title="No steps were planned"
                      description="The planner produced a summary but no executable steps. Discard this draft and rephrase the request — running an empty plan would achieve nothing."
                      action={
                        <Button variant="secondary" onClick={discard}>
                          Rewrite the request
                        </Button>
                      }
                    />
                  ) : (
                    <>
                      <PlanPreview steps={plan.plan} />
                      <PlanNotes steps={plan.plan} />
                    </>
                  )}
                </Panel>
              </div>
            </div>

            {/* --- Side column: the inference, the entities, the decision -- */}
            <aside className="lg:col-span-5 xl:col-span-4">
              <div className="space-y-4 lg:sticky lg:top-24">
                <div className="animate-fade-up" style={{ animationDelay: "200ms" }}>
                  <Panel
                    title="What the agent extracted"
                    description="Parsed from your sentence. Nothing here came from a form field."
                    icon={<Wand2 className="size-4" />}
                  >
                    {/* The inference, called out as the inference it is */}
                    <div className="rounded-[18px] border border-[#b9d8e1] bg-[#e9f3f8]/70 p-4">
                      <div className="flex items-center gap-2.5">
                        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white text-[#38677b] shadow-[0_4px_12px_rgba(46,96,120,0.10)]">
                          {plan.entities.workflow_type === "reimbursement" ? (
                            <Receipt className="size-4" />
                          ) : (
                            <ShoppingCart className="size-4" />
                          )}
                        </span>
                        <div className="min-w-0">
                          <p className="text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
                            {humanise(plan.entities.workflow_type)}
                          </p>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                            Inferred workflow type
                          </p>
                        </div>
                      </div>
                      <p className="mt-3 text-[12px] leading-relaxed text-[#5f7280]">
                        Inferred from your words alone. The request body carries
                        text and nothing else — the API rejects a type hint — so
                        this classification, and every step beside it, follows from
                        how you phrased it.
                      </p>
                    </div>
  
                    <DetailList
                      className="mt-4"
                      items={[
                        { label: "Currency", value: plan.entities.currency },
                        {
                          label: "Budget ceiling",
                          value:
                            plan.entities.budget === null ||
                            plan.entities.budget === undefined ? (
                              <span className="font-medium text-[#7e8c94]">
                                No ceiling given
                              </span>
                            ) : (
                              <span className="tnum">
                                {money(plan.entities.budget, plan.entities.currency)}
                              </span>
                            ),
                        },
                        {
                          label: "Approver",
                          value: plan.entities.approver ?? (
                            <span className="font-medium text-[#7e8c94]">Not named</span>
                          ),
                        },
                      ]}
                    />
  
                    <ExtractedItems plan={plan} />
  
                    {plan.entities.notes && (
                      <div className="mt-4 rounded-[14px] bg-white/60 px-3.5 py-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#a3b6c0]">
                          Notes kept
                        </p>
                        <p className="mt-1 text-[12.5px] leading-relaxed text-[#5f7280]">
                          {plan.entities.notes}
                        </p>
                      </div>
                    )}
  
                    {plan.planner_attempts > 1 && (
                      <p className="mt-5 flex items-start gap-2 border-t border-[#eef4f7] pt-4 text-[11.5px] leading-relaxed text-[#7e8c94]">
                        <RefreshCw className="mt-0.5 size-3 shrink-0" />
                        <span>
                          The planner re-prompted itself{" "}
                          {plan.planner_attempts - 1}{" "}
                          {plan.planner_attempts - 1 === 1 ? "time" : "times"}{" "}
                          before its output validated against the schema. That
                          repair loop is part of the design — what you are reading
                          is the attempt that passed.
                        </span>
                      </p>
                    )}
                  </Panel>
                </div>

                <div className="animate-fade-up" style={{ animationDelay: "270ms" }}>
                  <Card className="p-5">
                    {runMutation.isError && (
                      <RequestError
                        error={runMutation.error}
                        onRetry={confirm}
                        workflowId={plan.workflow_id}
                        className="mb-3"
                      />
                    )}
                    <Button
                      size="lg"
                      full
                      onClick={confirm}
                      loading={runMutation.isPending}
                      iconRight={<ArrowRight className="size-4" />}
                    >
                      {runMutation.isPending ? "Starting…" : "Confirm and run"}
                    </Button>
                    <Button
                      variant="ghost"
                      full
                      className="mt-2"
                      icon={<X className="size-3.5" />}
                      onClick={discard}
                      disabled={runMutation.isPending}
                    >
                      Discard
                    </Button>
                    <p className="mt-3.5 text-center text-[11.5px] leading-relaxed text-[#7e8c94]">
                      Confirming starts the graph and takes you to the live run,
                      where every step and every tool call is visible as it
                      happens.
                    </p>
                    <div className="mt-4 flex items-center justify-between gap-2 border-t border-[#eef4f7] pt-3">
                      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#a3b6c0]">
                        Draft id
                      </span>
                      <div className="flex min-w-0 items-center gap-1">
                        {/* Short form on screen, full id on the clipboard —
                            the same treatment ids get everywhere else. */}
                        <Mono>{plan.workflow_id.slice(0, 8)}</Mono>
                        <CopyButton value={plan.workflow_id} label="Copy" />
                      </div>
                    </div>
                  </Card>
                </div>
              </div>
            </aside>
          </div>
        </div>
      )}
    </>
  );
}

/* ==========================================================================
   Pieces
   ========================================================================== */

/** Cycles the planner's phase caption while a request is in flight. */
function usePlanningPhase(active: boolean): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }
    const timer = window.setInterval(() => {
      // Clamp rather than loop: pretending to restart would be a lie about
      // what the planner is doing on a slow call.
      setIndex((previous) => Math.min(previous + 1, PLANNING_PHASES.length - 1));
    }, 1400);
    return () => window.clearInterval(timer);
  }, [active]);
  return index;
}

function StageTrail({ stage }: { stage: Stage }) {
  const current = STAGE_TRAIL.findIndex((item) => item.key === stage);
  return (
    <ol className="flex flex-wrap items-center gap-2">
      {STAGE_TRAIL.map((item, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={item.key} className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.07em] transition-colors duration-200",
                active
                  ? "gradient-cta border-transparent text-white shadow-[0_6px_16px_rgba(46,96,120,0.26)]"
                  : done
                    ? "border-[#b9d8e1] bg-[#e9f3f8] text-[#38677b]"
                    : "border-[#e3ebef] bg-white/50 text-[#a3b6c0]",
              )}
            >
              <span className="tnum">{index + 1}</span>
              {item.label}
            </span>
            {index < STAGE_TRAIL.length - 1 && (
              <span
                className={cn(
                  "h-px w-5 rounded-full",
                  done ? "bg-[#b9d8e1]" : "bg-[#e3ebef]",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The request as the user sent it, in a chat bubble on their side. */
function RequestBubble({ text }: { text: string }) {
  return (
    <div className="animate-fade-up flex justify-end">
      <div className="glass-flat min-w-0 max-w-full rounded-[24px] rounded-br-[8px] px-4 py-3 sm:max-w-[620px]">
        {/* The user's own words, so an unbreakable token — a pasted URL, a long
            part number — has to wrap rather than push the page sideways. */}
        <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-[#3e505a]">
          {text}
        </p>
      </div>
    </div>
  );
}

function PlanNote({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-[16px] bg-[#e9f3f8]/70 px-3.5 py-3">
      <span className="mt-0.5 shrink-0 text-[#447f98]">{icon}</span>
      <p className="text-[12px] leading-relaxed text-[#5f7280]">{children}</p>
    </div>
  );
}

/**
 * The two claims the plan makes that a numbered list cannot show: the loop back
 * from `validate_po`, and the interrupt at `route_approval`.
 *
 * A reimbursement plan has no `validate_po`, so only one note applies there.
 * If a plan carries neither node the whole block — its rule and its padding —
 * is dropped rather than left as an empty ruled gap under the last step.
 */
function PlanNotes({ steps }: { steps: PlannedStep[] }) {
  const selfCorrects = steps.some((step) => step.name === "validate_po");
  const humanGate = steps.some((step) => step.name === "route_approval");
  if (!selfCorrects && !humanGate) return null;

  return (
    <div className="mt-6 space-y-2.5 border-t border-[#eef4f7] pt-5">
      {selfCorrects && (
        <PlanNote icon={<RefreshCw className="size-3.5" />}>
          This is not a straight line. If the agent validates its own purchase
          order and the checks fail, it loops back, regenerates the document and
          re-checks it — up to a fixed self-correction budget. When that budget
          runs out, it escalates to a person instead of guessing.
        </PlanNote>
      )}
      {humanGate && (
        <PlanNote icon={<ShieldCheck className="size-3.5" />}>
          The last step is a hard interrupt, not a notification. The graph pauses
          there until an administrator approves or rejects. The agent never
          approves its own work.
        </PlanNote>
      )}
    </div>
  );
}

/** The line items the planner pulled out, with the columns each type needs. */
function ExtractedItems({ plan }: { plan: WorkflowPlanResponse }) {
  const items = plan.entities.items;
  const currency = plan.entities.currency;
  const showAmount = items.some(
    (item) => item.amount !== null && item.amount !== undefined,
  );
  const showReceipt = items.some(
    (item) => item.receipt !== null && item.receipt !== undefined,
  );

  return (
    <div className="mt-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#a3b6c0]">
        Line items
      </p>

      {items.length === 0 ? (
        <EmptyState
          className="mt-2 py-8"
          title="No line items extracted"
          description="The planner found nothing countable in the request. The plan can still run, but if you expected a list here, rephrase with quantities."
        />
      ) : (
        <Table className="mt-2" minWidth={showAmount || showReceipt ? 320 : 220}>
          <thead>
            <tr>
              <Th>Item</Th>
              <Th align="right">Qty</Th>
              {showAmount && <Th align="right">Amount</Th>}
              {showReceipt && <Th align="center">Receipt</Th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <Tr key={`${item.name}-${index}`}>
                <Td>
                  <p className="font-medium text-[#243640]">{item.name}</p>
                  {(item.specification || item.category_hint) && (
                    <p className="mt-0.5 text-[11.5px] leading-snug text-[#7e8c94]">
                      {item.specification}
                      {item.specification && item.category_hint ? " · " : ""}
                      {item.category_hint}
                    </p>
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  <span className="font-semibold">
                    {formatNumber(item.quantity)}
                  </span>
                  {item.unit && (
                    <span className="ml-1 text-[11.5px] font-normal text-[#7e8c94]">
                      {item.unit}
                    </span>
                  )}
                </Td>
                {showAmount && (
                  <Td align="right" className="whitespace-nowrap">
                    {item.amount === null || item.amount === undefined
                      ? "—"
                      : money(item.amount, currency)}
                  </Td>
                )}
                {showReceipt && (
                  <Td align="center" className="text-[11.5px] font-semibold">
                    {item.receipt === null || item.receipt === undefined ? (
                      <span className="text-[#b3c4cc]">—</span>
                    ) : item.receipt ? (
                      <span className="text-[#067647]">Attached</span>
                    ) : (
                      <span className="text-[#b42318]">Missing</span>
                    )}
                  </Td>
                )}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/**
 * One failure, explained in the terms that make it actionable.
 *
 * A 422 is the planner declining the text — the user can fix that, and their
 * words are still in the box. A 503 is a dependency the operator has not
 * configured, which is nothing the user did; naming the dependency by its
 * error code is more useful than a red box.
 */
function RequestError({
  error,
  onRetry,
  className,
  workflowId,
}: {
  error: unknown;
  onRetry: () => void;
  className?: string;
  /** Present on the confirm step, where a 409 has somewhere to send you. */
  workflowId?: string;
}) {
  if (error instanceof ApiError) {
    if (error.isUnavailable) {
      const dependency =
        error.code === "llm_not_configured"
          ? "The server has no Claude API credentials configured, so it cannot plan anything."
          : error.code === "database_not_configured"
            ? "The server has no database connection configured, so it cannot save a draft."
            : "A backend dependency is not configured.";
      return (
        <Alert
          tone="warning"
          title="The planner is unavailable"
          className={className}
          action={
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          }
        >
          <p>{dependency} This is an operator setting, not a problem with your request — your text is untouched.</p>
          <p className="mt-1.5 opacity-80">
            {error.message}
            {error.code ? (
              <>
                {" · "}
                <Mono>{error.code}</Mono>
              </>
            ) : null}
          </p>
        </Alert>
      );
    }

    if (error.isForbidden) {
      return (
        <Alert tone="danger" title="Not available on this account" className={className}>
          {error.message}
        </Alert>
      );
    }

    if (error.status === 409) {
      // The server phrases this with the raw status value ("workflow is
      // running"); say it in the console's own words and give the user the
      // one thing they actually want, which is the run itself.
      return (
        <Alert
          tone="warning"
          title="This draft has already started"
          className={className}
          action={
            <Link
              href={workflowId ? `/workflows/${workflowId}` : "/workflows"}
              className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-[12px] border border-white/80 bg-white/75 px-3.5 text-[12.5px] font-semibold text-[#243640] shadow-[0_8px_22px_rgba(46,96,120,0.10)] transition-colors duration-200 hover:bg-white/95"
            >
              {workflowId ? "Open the run" : "Workflows"}
              <ArrowRight className="size-3.5" />
            </Link>
          }
        >
          Only a draft can be started, and this one is no longer a draft — it was
          confirmed already. Nothing was run twice.
        </Alert>
      );
    }

    if (error.status === 422) {
      return (
        <Alert
          tone="danger"
          title="The planner could not turn that into a plan"
          className={className}
        >
          <p>{error.message}</p>
          {error.details.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
              {error.details.map((detail, index) => (
                <li key={index}>
                  {detail.field ? `${detail.field}: ` : ""}
                  {detail.message}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 opacity-80">
            Your text is still below. Naming the quantity, the budget or the
            approver usually gives it enough to work with.
          </p>
        </Alert>
      );
    }
  }

  // Everything else — a transport failure, a 404, a 500. This is a submission,
  // not a fetch, so it must not read "could not load this".
  return (
    <Alert
      tone="danger"
      title="Could not send that request"
      className={className}
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {error instanceof Error ? error.message : "Something went wrong."}
    </Alert>
  );
}
