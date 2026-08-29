"use client";

/**
 * Live execution — screens 4a and 4b.
 *
 * Two channels, one truth. The WebSocket is a *change signal*: every frame
 * simply invalidates the REST query, and `GET /workflows/{id}` re-renders the
 * screen. The socket never mutates local state that the database does not
 * also hold, so this screen cannot drift from the row it is showing — and a
 * dropped frame costs nothing, because the next fetch is authoritative.
 *
 * The same reasoning drives the poll: while the workflow is non-terminal the
 * query refetches every 2.5s regardless of the socket. Corporate proxies kill
 * idle WebSockets; the run must still advance on screen when that happens, so
 * "Polling" is a supported mode rather than an error.
 */
import {
  ArrowLeft,
  ChevronLeft,
  FileText,
  MessageSquareQuote,
  Play,
  Radio,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyButton,
  DetailList,
  EmptyState,
  ErrorState,
  LiveDot,
  Mono,
  Panel,
  ProgressBar,
  Skeleton,
  Spinner,
  StatusPill,
  TONE_DOT,
  cn,
} from "@/components/ui";
import { ExecutionTimeline } from "@/components/workflow/ExecutionTimeline";
import { WorkflowNav } from "@/components/workflow/WorkflowNav";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  WORKFLOW_STATUS_LABEL,
  WORKFLOW_STATUS_TONE,
  dateTime,
  duration,
  humanise,
  money,
  number as fmtNumber,
  parseDate,
  relativeTime,
  timeOnly,
  type Tone,
} from "@/lib/format";
import type {
  ApprovalRequiredPayload,
  ComparisonReadyPayload,
  SelfCorrectionPayload,
  StepCompletedPayload,
  StepFailedPayload,
  StepRetryingPayload,
  StepStartedPayload,
  ToolCalledPayload,
  ValidationResultPayload,
  WSEventType,
  WSFrame,
  WorkflowCompletedPayload,
  WorkflowEscalatedPayload,
  WorkflowStatusPayload,
} from "@/lib/types";
import {
  isTerminalStatus,
  useWorkflowStream,
  type ConnectionState,
} from "@/lib/useWorkflowStream";
import { QuoteRequestPanel } from "./QuoteRequestPanel";

const FEED_LENGTH = 12;

/* ==========================================================================
   The event feed
   ========================================================================== */

/**
 * The frame's payload, typed.
 *
 * `payload` is a JSON blob on the wire — the orchestrator emits plain dicts
 * rather than validated models, and replayed frames come straight back out of
 * `workflow_events.payload`. So the cast is a convenience for the happy path
 * only: every reader below still guards the field it touches, because a frame
 * persisted by an older emitter is still replayed to this screen.
 */
function payloadOf<T>(frame: WSFrame): Partial<T> {
  const payload = frame.payload as unknown;
  return payload && typeof payload === "object" ? (payload as Partial<T>) : {};
}

/** Nullable-safe join for a wire field that is documented as a list. */
function joinList(value: unknown): string {
  return Array.isArray(value) ? value.filter(Boolean).join(", ") : "";
}

/** Nullable-safe integer for a wire field that is documented as a number. */
function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : null;
}

/** Human copy for the wire event name — never the raw enum in the UI. */
const EVENT_LABEL: Record<WSEventType, string> = {
  "workflow.status_changed": "Status changed",
  "step.started": "Step started",
  "step.completed": "Step completed",
  "step.failed": "Step failed",
  "step.retrying": "Auto-retrying",
  "tool.called": "Tool called",
  "comparison.ready": "Quotes scored",
  "validation.result": "Validation result",
  "selfcorrection.started": "Self-correction",
  "approval.required": "Approval required",
  "workflow.completed": "Workflow finished",
  "workflow.escalated": "Escalated",
  heartbeat: "Heartbeat",
};

const EVENT_TONE: Record<WSEventType, Tone> = {
  "workflow.status_changed": "brand",
  "step.started": "brand",
  "step.completed": "positive",
  "step.failed": "danger",
  "step.retrying": "warning",
  "tool.called": "neutral",
  "comparison.ready": "brand",
  "validation.result": "brand",
  "selfcorrection.started": "warning",
  "approval.required": "warning",
  "workflow.completed": "positive",
  "workflow.escalated": "warning",
  heartbeat: "muted",
};

/**
 * One line per frame.
 *
 * Every read is optional and every list is checked before it is joined: this
 * panel renders frames replayed out of the database as well as live ones, so
 * a payload written by an earlier emitter — or truncated — must degrade to a
 * shorter sentence rather than take the page down with it. Where a field is
 * missing the clause that needed it is simply dropped.
 */
function describe(frame: WSFrame): string {
  switch (frame.type) {
    case "workflow.status_changed": {
      const payload = payloadOf<WorkflowStatusPayload>(frame);
      const label = payload.status
        ? (WORKFLOW_STATUS_LABEL[payload.status] ?? humanise(payload.status))
        : "Status updated";
      const progress = asInt(payload.progress_percent);
      return progress === null ? label : `${label} · ${progress}% complete`;
    }
    case "step.started": {
      const payload = payloadOf<StepStartedPayload>(frame);
      const head = payload.title ?? humanise(payload.name);
      return payload.tool_name ? `${head} — calling ${payload.tool_name}` : head;
    }
    case "step.completed": {
      const payload = payloadOf<StepCompletedPayload>(frame);
      const head = `${humanise(payload.name)} in ${duration(payload.duration_ms)}`;
      return payload.output_summary ? `${head} · ${payload.output_summary}` : head;
    }
    case "step.failed": {
      const payload = payloadOf<StepFailedPayload>(frame);
      const reason = payload.error ? `: ${payload.error}` : ".";
      return payload.will_retry
        ? `${humanise(payload.name)} failed — retrying (${asInt(payload.retry_count) ?? 1} of ${asInt(payload.max_retries) ?? "—"})${reason}`
        : `${humanise(payload.name)} failed${reason}`;
    }
    case "step.retrying": {
      const payload = payloadOf<StepRetryingPayload>(frame);
      const reason = payload.reason ? `: ${payload.reason}` : ".";
      return `${humanise(payload.name)} — attempt ${asInt(payload.attempt) ?? 1} of ${asInt(payload.max_attempts) ?? "—"}${reason}`;
    }
    case "tool.called": {
      const payload = payloadOf<ToolCalledPayload>(frame);
      return `${payload.tool_name ?? "Tool"} → ${humanise(payload.status)} in ${duration(
        payload.duration_ms,
      )}`;
    }
    case "comparison.ready": {
      const payload = payloadOf<ComparisonReadyPayload>(frame);
      const count = asInt(payload.quote_count);
      const head =
        count === null
          ? "Quotes scored"
          : `${count} quote${count === 1 ? "" : "s"} scored`;
      return payload.selected_vendor_name
        ? `${head} · leading: ${payload.selected_vendor_name}`
        : head;
    }
    case "validation.result": {
      const payload = payloadOf<ValidationResultPayload>(frame);
      const passed = asInt(payload.passed_count);
      const total = asInt(payload.total_checks);
      const attempt = asInt(payload.attempt);
      const counted =
        passed !== null && total !== null
          ? `${passed} of ${total} checks passed`
          : payload.passed
            ? "All checks passed"
            : "Checks failed";
      const head = attempt === null ? counted : `${counted} on attempt ${attempt}`;
      // Documented as a list, but a frame written before that field existed
      // replays with it absent — so it is checked, not assumed.
      const failed = joinList(payload.failed_check_titles);
      return payload.passed || !failed ? head : `${head} · failed: ${failed}`;
    }
    case "selfcorrection.started": {
      const payload = payloadOf<SelfCorrectionPayload>(frame);
      const reason = payload.reason ? `: ${payload.reason}` : ".";
      return `Regenerating — attempt ${asInt(payload.attempt) ?? 1} of ${asInt(payload.max_attempts) ?? "—"}${reason}`;
    }
    case "approval.required": {
      const payload = payloadOf<ApprovalRequiredPayload>(frame);
      // `currency` is emitted straight from graph state and can be absent;
      // money() only falls back to the org default for `undefined`, so a
      // null would otherwise render as "null 1,200,000".
      const amount = money(payload.total_amount, payload.currency ?? undefined);
      return payload.vendor_name
        ? `${amount} with ${payload.vendor_name} — awaiting an administrator`
        : `${amount} — awaiting an administrator`;
    }
    case "workflow.completed": {
      const payload = payloadOf<WorkflowCompletedPayload>(frame);
      const label = payload.status
        ? (WORKFLOW_STATUS_LABEL[payload.status] ?? humanise(payload.status))
        : "Finished";
      return payload.duration_ms
        ? `${label} in ${duration(payload.duration_ms)}`
        : label;
    }
    case "workflow.escalated": {
      const payload = payloadOf<WorkflowEscalatedPayload>(frame);
      const head = payload.stage
        ? `${payload.reason ?? "Escalated"} at ${payload.stage}`
        : (payload.reason ?? "Escalated for human review");
      return payload.detail ? `${head} — ${payload.detail}` : head;
    }
    default:
      return "";
  }
}

/** Nothing in a transcript line is worth a blank screen. */
function summarise(frame: WSFrame): string {
  try {
    return describe(frame);
  } catch {
    return "This frame arrived in a shape this build does not recognise.";
  }
}

/* ==========================================================================
   Small local pieces
   ========================================================================== */

function ConnectionBadge({
  connection,
  lastHeartbeat,
  onReconnect,
}: {
  connection: ConnectionState;
  lastHeartbeat: string | null;
  onReconnect: () => void;
}) {
  if (connection === "open") {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full border border-[#b9d8e1] bg-[#d6ebf3] px-3 py-1.5 text-[11.5px] font-semibold text-[#38677b]"
        title={
          lastHeartbeat
            ? `Last heartbeat ${timeOnly(lastHeartbeat)}`
            : "Streaming from the orchestrator"
        }
      >
        <LiveDot />
        Live
      </span>
    );
  }

  if (connection === "connecting" || connection === "reconnecting") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-white/80 bg-white/60 px-3 py-1.5 text-[11.5px] font-semibold text-[#5f7280]">
        <Spinner className="size-3" />
        {connection === "connecting" ? "Connecting…" : "Reconnecting…"}
      </span>
    );
  }

  if (connection === "idle") return null;

  // Closed or refused. The REST poll still drives the screen, so this is a
  // change of transport, not a failure.
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/80 bg-white/60 py-1 pl-3 pr-1 text-[11.5px] font-semibold text-[#5f7280]">
      <Radio className="size-3.5 text-[#a3b6c0]" />
      Polling every 2.5s
      <button
        type="button"
        onClick={onReconnect}
        className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-[#447f98] transition-colors hover:bg-[#e9f3f8]"
      >
        <RefreshCw className="size-3" />
        Reconnect
      </button>
    </span>
  );
}

function Metric({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
        {label}
      </dt>
      <dd
        className="tnum mt-1 text-[15px] font-semibold tracking-[-0.01em] text-[#243640]"
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}

/* ==========================================================================
   Page
   ========================================================================== */
export default function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const { data, isLoading, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["workflow", id],
    queryFn: () => api.getWorkflow(id),
    // The socket is the fast path; this is the one that cannot be blocked.
    // It stops the moment the workflow can no longer change.
    refetchInterval: (query) =>
      isTerminalStatus(query.state.data?.status) ? false : 2500,
  });

  // 404 and 403 are the two answers that will not change by asking again, and
  // they are the same two the socket handshake refuses with 1008 — so do not
  // open it at all. Any other error is transient: the socket stays enabled,
  // because a run in progress is exactly when we want it back.
  const refused =
    error instanceof ApiError && (error.isNotFound || error.isForbidden);

  const { frames, connection, lastHeartbeat, reconnect } = useWorkflowStream(id, {
    // Gated on the status the row is actually in: a finished run can emit
    // nothing more, so the socket closes and only the (also stopped) poll
    // would have anything left to say.
    enabled: !isTerminalStatus(data?.status) && !refused,
    // Every frame is a hint that the row moved — re-read the row.
    onEvent: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflow", id] });
    },
  });

  /**
   * A draft has been planned and nothing more. `POST /workflows/{id}/run` is
   * the only thing that starts the graph, and the history list links straight
   * here — so this screen has to offer it, or a draft is a dead end.
   */
  const runMutation = useMutation({
    mutationFn: () => api.runWorkflow(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflow", id] });
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });

  /* ---------------------------------------------------------------- loading */
  if (isLoading) {
    return (
      <>
        <PageHeader title="Loading workflow…" />
        <div className="space-y-5">
          <Skeleton className="h-12 w-full rounded-[16px]" />
          <Skeleton className="h-44 w-full rounded-[28px]" />
          <div className="grid gap-5 lg:grid-cols-3">
            <Skeleton className="h-[420px] rounded-[28px] lg:col-span-2" />
            <Skeleton className="h-[420px] rounded-[28px]" />
          </div>
        </div>
      </>
    );
  }

  /* ------------------------------------------------------------------ error
     Only when there is nothing to show.

     This screen polls every 2.5s while a run is live, so `error` is set by
     any single failed poll — a dropped Wi-Fi frame, a backend restart — while
     the last good snapshot is still in the cache. Replacing a running
     workflow with a red panel because one request in a hundred timed out is
     worse than keeping the state on screen and saying it may be a moment old,
     which is what the banner below the header does. */
  if (!data) {
    const notFound = error instanceof ApiError && error.isNotFound;
    const forbidden = error instanceof ApiError && error.isForbidden;

    if (notFound || forbidden) {
      return (
        <>
          <PageHeader
            title="Workflow"
            breadcrumb={
              <Link
                href="/workflows"
                className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#7e8c94] transition-colors hover:text-[#447f98]"
              >
                <ChevronLeft className="size-3.5" />
                Workflows
              </Link>
            }
          />
          <EmptyState
            icon={<ShieldAlert className="size-6" />}
            title={
              notFound
                ? "That workflow is not here"
                : "This workflow is not yours to open"
            }
            description={
              notFound
                ? "The id in the address does not match any workflow you can see. It may have been removed, or it may belong to another requester."
                : "Workflows are visible to the person who raised them and to administrators. Vendor accounts never see buyer workflows at all."
            }
            action={
              <Button variant="secondary" onClick={() => router.push("/workflows")}>
                Back to history
              </Button>
            }
          />
        </>
      );
    }

    return (
      <>
        <PageHeader title="Workflow" />
        <ErrorState error={error} onRetry={() => void refetch()} />
      </>
    );
  }

  /* ------------------------------------------------------------------- data */
  const terminal = isTerminalStatus(data.status);
  const running = data.status === "running";
  const isDraft = data.status === "draft";
  const entities = data.entities;
  const currency = data.currency;
  // `entities` and `plan` are stored JSON blobs (`entities_json`, `plan_json`)
  // served back verbatim, so their shape is whatever the planner wrote on the
  // day the row was created — `Array.isArray`, not `?? []`, is what makes a
  // malformed blob render as "nothing here" instead of throwing on `.map`.
  const requestItems = Array.isArray(entities?.items) ? entities.items : [];
  const plannedSteps = Array.isArray(data.plan) ? data.plan : [];
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const stepsDone = steps.filter((step) => step.status === "completed").length;
  // Before the first node runs there are no step rows — the plan is all there
  // is to show, and showing it is the point of screen 3a.
  const showPlanOnly = steps.length === 0 && plannedSteps.length > 0;

  // duration_ms is only written when the run reaches a terminal status, so a
  // live run would otherwise show "—" under a label that promises a clock.
  const startedAt = parseDate(data.created_at);
  const elapsedMs =
    data.duration_ms ??
    (running && startedAt ? Math.max(0, Date.now() - startedAt.getTime()) : null);

  // A tab is only offered once the thing behind it exists — the reimbursement
  // graph has no quotes, no PO and no validation, so those stay closed there.
  const ran = (name: string) => {
    const step = steps.find((candidate) => candidate.name === name);
    return step?.status === "completed" || step?.status === "failed";
  };

  const feed = frames.slice(-FEED_LENGTH).reverse();
  // The poll is still running behind this render; `error` here means the last
  // attempt failed while a good snapshot stayed on screen.
  const staleSince = error ? dataUpdatedAt : null;

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link
            href="/workflows"
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#7e8c94] transition-colors hover:text-[#447f98]"
          >
            <ArrowLeft className="size-3.5" />
            Workflows
          </Link>
        }
        title={data.title}
        description={data.summary ?? undefined}
        actions={
          <>
            <ConnectionBadge
              connection={connection}
              lastHeartbeat={lastHeartbeat}
              onReconnect={reconnect}
            />
            {isDraft && (
              <Button
                icon={<Play className="size-3.5" />}
                loading={runMutation.isPending}
                onClick={() => runMutation.mutate()}
              >
                Run this workflow
              </Button>
            )}
            {data.status === "completed" && (
              <Button
                icon={<FileText className="size-3.5" />}
                onClick={() => router.push(`/workflows/${id}/report`)}
              >
                View report
              </Button>
            )}
            {(data.status === "escalated" ||
              data.status === "failed" ||
              data.status === "rejected") && (
              <Button
                variant="secondary"
                icon={<ScrollText className="size-3.5" />}
                onClick={() => router.push(`/workflows/${id}/audit`)}
              >
                View audit trail
              </Button>
            )}
          </>
        }
      />

      <WorkflowNav
        workflowId={id}
        className="mb-5"
        available={{
          comparison: ran("fetch_quotes") || ran("score_rank"),
          validation: ran("validate_po"),
          purchaseOrder: ran("generate_po"),
          report: data.status === "completed",
          audit: true,
        }}
      />

      {/* A poll that failed while a good snapshot is still on screen. Warning,
          not danger: nothing is broken, the figures are simply a moment old. */}
      {staleSince !== null && (
        <Alert
          tone="warning"
          title="Showing the last state we could read"
          icon={<RefreshCw className="size-4" />}
          className="mb-5"
          action={
            <Button size="sm" variant="secondary" onClick={() => void refetch()}>
              Retry now
            </Button>
          }
        >
          The last refresh did not reach the API, so this page is as of{" "}
          {relativeTime(new Date(staleSince).toISOString())}. It keeps trying on
          its own — nothing on screen has been lost.
        </Alert>
      )}

      {/* ------------------------------------------------------------------
          Status strip
          ------------------------------------------------------------------ */}
      <Card className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill
            label={WORKFLOW_STATUS_LABEL[data.status]}
            tone={WORKFLOW_STATUS_TONE[data.status]}
          />
          <Badge tone="neutral">{humanise(data.workflow_type)}</Badge>
          <span className="flex items-center gap-1">
            <Mono>{id.slice(0, 8)}</Mono>
            <CopyButton value={id} label="Copy id" />
          </span>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <Metric label="Total" value={money(data.total_amount, currency)} />
          <Metric label="Budget" value={money(data.budget, currency)} />
          <Metric
            label="Created"
            value={relativeTime(data.created_at)}
            title={dateTime(data.created_at)}
          />
          <Metric
            label={terminal ? "Took" : running ? "Elapsed" : "Duration"}
            value={duration(elapsedMs)}
            title={
              data.completed_at
                ? `Finished ${dateTime(data.completed_at)}`
                : running
                  ? "Since the request was raised"
                  : undefined
            }
          />
        </dl>

        <div className="mt-6">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
              Progress
            </p>
            <p className="tnum text-[12px] font-semibold text-[#5f7280]">
              {steps.length === 0
                ? "Not started"
                : `${stepsDone} of ${steps.length} steps · ${Math.round(
                    data.progress_percent ?? 0,
                  )}%`}
            </p>
          </div>
          <ProgressBar
            value={data.progress_percent ?? 0}
            animated={data.status === "running"}
            tone={WORKFLOW_STATUS_TONE[data.status]}
            height={8}
            className="mt-2.5"
          />
        </div>
      </Card>

      {/* ------------------------------------------------------------------
          Quote requests

          The way out of the dead end: ask the vendors for a price, let each
          published reply land in that vendor's catalog, then run this workflow
          again. The agent is unchanged — it still only reads the catalog.

          Full width, above the execution grid, for two reasons. On an
          escalated run this is the only thing on the screen the buyer can
          act on, so it leads. And it carries a seven-column table of replies,
          which the narrow sticky context column beside the timeline cannot
          hold without scrolling every row sideways.

          Mounted for anything that has actually run: the panel answers its own
          404 with silence, so a workflow with no request costs a single
          request and renders nothing — which is why the spacing is passed in
          rather than wrapped around it. A draft has not run and has nothing to
          escalate about, so it is left out entirely. */}
      {!isDraft && (
        <QuoteRequestPanel
          workflowId={id}
          status={data.status}
          escalationReason={data.escalation_reason}
          className="mb-5"
        />
      )}

      {/* ------------------------------------------------------------------
          Execution + context
          ------------------------------------------------------------------ */}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel
            title={showPlanOnly ? "The plan" : "Execution"}
            description={
              showPlanOnly
                ? "Nothing has executed yet. This is the sequence the planner wrote, in the order it will run."
                : "Each node the state machine has entered, with the tool calls it made and how long each took."
            }
          >
            {showPlanOnly ? (
              <ol className="space-y-2">
                {plannedSteps.map((step, index) => (
                  <li
                    key={`${step.order}-${step.name}-${index}`}
                    className="flex gap-3 rounded-[16px] bg-white/60 px-3.5 py-3"
                  >
                    <span className="tnum mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[#e9f3f8] text-[11px] font-semibold text-[#38677b]">
                      {step.order}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-[#243640]">
                        {step.title}
                      </p>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#7e8c94]">
                        {step.description}
                      </p>
                      {step.tool_name && (
                        <Mono className="mt-1.5 inline-block">{step.tool_name}</Mono>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <ExecutionTimeline steps={steps} />
            )}
          </Panel>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:max-h-[calc(100dvh-8rem)] lg:self-start lg:overflow-y-auto lg:pb-2">
          {/* -------------------------------------------------------- draft */}
          {isDraft && (
            <Alert
              tone="brand"
              title="Planned, not started"
              icon={<Play className="size-4" />}
            >
              Submitting a request only writes a plan. Nothing calls a tool,
              touches a vendor or spends a budget until this is run, and the
              agent will not start on its own.
              <div className="mt-3">
                <Button
                  size="sm"
                  icon={<Play className="size-3.5" />}
                  loading={runMutation.isPending}
                  onClick={() => runMutation.mutate()}
                >
                  Run this workflow
                </Button>
              </div>
            </Alert>
          )}

          {runMutation.error && (
            <Alert tone="danger" title="Could not start this run">
              {runMutation.error instanceof Error
                ? runMutation.error.message
                : "Something went wrong."}
            </Alert>
          )}

          {/* ---------------------------------------------------------- ask */}
          <Panel
            title="The request"
            icon={<MessageSquareQuote className="size-4" />}
            bodyClassName="pt-5"
          >
            <blockquote className="glass-flat rounded-[18px] border-l-[3px] border-l-[#447f98] px-4 py-3 text-[13px] leading-relaxed text-[#3b4d57]">
              {data.request_text}
            </blockquote>
            <p className="mt-3 text-[11.5px] leading-relaxed text-[#7e8c94]">
              The workflow type was inferred from this text alone — nothing in
              the request named a template.
            </p>
          </Panel>

          {/* ------------------------------------------------------ entities */}
          {entities && (
            <Panel title="What the planner extracted" bodyClassName="pt-4">
              <DetailList
                items={[
                  { label: "Budget", value: money(entities.budget, currency) },
                  { label: "Currency", value: currency },
                  { label: "Approver", value: entities.approver ?? "Not specified" },
                ]}
              />

              {requestItems.length > 0 && (
                <>
                  <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                    Line items
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {requestItems.map((item, index) => (
                      <li
                        key={`${item.name}-${index}`}
                        className="flex items-start justify-between gap-3 rounded-[14px] bg-white/60 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-[12.5px] font-semibold text-[#243640]">
                            {item.name}
                          </p>
                          {item.specification && (
                            <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#7e8c94]">
                              {item.specification}
                            </p>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="tnum text-[12.5px] font-semibold text-[#243640]">
                            {fmtNumber(item.quantity)}
                            {item.unit ? ` ${item.unit}` : ""}
                          </p>
                          {item.amount !== null && item.amount !== undefined && (
                            <p className="tnum mt-0.5 text-[11.5px] text-[#7e8c94]">
                              {money(item.amount, currency)}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {entities.notes && (
                <p className="mt-4 text-[12px] leading-relaxed text-[#5f7280]">
                  {entities.notes}
                </p>
              )}
            </Panel>
          )}

          {/* ----------------------------------------------- self-correction */}
          {data.self_correction_attempts > 0 && (
            <Alert
              tone="warning"
              title="The agent corrected itself"
              icon={<RefreshCw className="size-4" />}
            >
              Validation rejected the purchase order it had written, so the
              agent went back to <Mono>generate_po</Mono> and produced a new one
              rather than handing a bad document to a human. Regeneration
              attempts: <strong className="tnum">{data.self_correction_attempts}</strong>.
              The loop is budget-limited — when it runs out, the run escalates
              instead of trying forever.
            </Alert>
          )}

          {/* --------------------------------------------------- escalation */}
          {data.status === "escalated" && (
            <Alert
              tone="warning"
              title="Escalated for human review"
              icon={<TriangleAlert className="size-4" />}
            >
              {data.escalation_reason ?? "The agent stopped and asked for a person."}
              <p className="mt-2">
                Nothing has been committed. This is no longer the end of the
                road: the quote request panel above asks every verified vendor
                for a price, and once one is published to their catalog this
                same workflow can be run again. The audit trail shows the exact
                point it stopped.
              </p>
              <div className="mt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ScrollText className="size-3.5" />}
                  onClick={() => router.push(`/workflows/${id}/audit`)}
                >
                  View audit trail
                </Button>
              </div>
            </Alert>
          )}

          {/* ----------------------------------------------- approval gate */}
          {data.status === "awaiting_approval" && (
            <Alert
              tone="warning"
              title="Paused at the human gate"
              icon={<ShieldCheck className="size-4" />}
            >
              The graph has interrupted itself before committing anything. Only
              an administrator can approve or reject it, and the agent will not
              resume — or auto-approve — on its own.
              {/* The queue is an admin route and the API refuses everyone
                  else, so offering the button to a requester would only send
                  them to a 403. */}
              {user?.role === "admin" && (
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => router.push("/admin/approvals")}
                  >
                    Open the approval queue
                  </Button>
                </div>
              )}
            </Alert>
          )}

          {/* -------------------------------------------------------- feed */}
          <Panel
            title="Live events"
            description={
              terminal
                ? "This run is finished. The full sequence is preserved in the audit trail."
                : "Straight off the socket, newest first."
            }
            bodyClassName="pt-4"
          >
            {feed.length === 0 ? (
              <p className="py-4 text-center text-[12px] leading-relaxed text-[#7e8c94]">
                {terminal
                  ? "No frames arrived in this session — the run had already finished when the page opened."
                  : "Nothing has come through yet. Frames appear the moment the orchestrator emits them."}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {feed.map((frame, index) => (
                  <li
                    // Live frames all carry `seq: 0` — the row id is not known
                    // when the orchestrator fans out, so only replayed frames
                    // have a real cursor. Position is what keeps the key unique.
                    key={`${frame.seq}-${frame.ts}-${index}`}
                    className="animate-fade-in flex gap-2.5 rounded-[12px] px-2 py-1.5 transition-colors hover:bg-white/60"
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        TONE_DOT[EVENT_TONE[frame.type] ?? "neutral"],
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        {/* The human name, with the wire event on the tooltip:
                            a transcript is still a screen, and `step.retrying`
                            is a machine key, not English. */}
                        <span
                          className="truncate text-[11.5px] font-semibold text-[#38677b]"
                          title={frame.type}
                        >
                          {EVENT_LABEL[frame.type] ?? humanise(frame.type)}
                        </span>
                        <span className="tnum shrink-0 font-mono text-[10.5px] text-[#a3b6c0]">
                          {timeOnly(frame.ts)}
                        </span>
                      </div>
                      <p className="mt-0.5 break-words text-[11.5px] leading-relaxed text-[#5f7280]">
                        {summarise(frame)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {lastHeartbeat && connection === "open" && (
              <p className="mt-3 border-t border-[#eef4f7] pt-3 font-mono text-[10.5px] text-[#a3b6c0]">
                heartbeat {timeOnly(lastHeartbeat)}
              </p>
            )}
          </Panel>
        </aside>
      </div>
    </>
  );
}
