"use client";

/**
 * Screen 10b — the audit trail.
 *
 * One node per recorded event, oldest first, grouped by calendar day. The
 * trail is not a table the app writes to: the backend assembles it as a
 * union over the workflow's steps, its tool calls and its approvals, which
 * is why it cannot drift from what actually executed. Nothing here is
 * editable, and nothing here is inferred.
 *
 * `reference_id` is deliberately prominent — it is the row somebody would
 * take to the database when they need to prove what happened.
 */
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  CircleDot,
  Info,
  ListChecks,
  Lock,
  type LucideIcon,
  ScrollText,
  SearchX,
  Server,
  ShieldCheck,
  Sparkles,
  User,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { use, useMemo, useState } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Button,
  Card,
  ChipGroup,
  CopyButton,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Mono,
  StatusPill,
  TONE_PILL,
  cn,
} from "@/components/ui";
import { WorkflowNav } from "@/components/workflow/WorkflowNav";
import { ApiError, api } from "@/lib/api";
import {
  STEP_STATUS_LABEL,
  STEP_STATUS_TONE,
  TOOL_STATUS_TONE,
  WORKFLOW_STATUS_LABEL,
  WORKFLOW_STATUS_TONE,
  dateOnly,
  duration,
  humanise,
  parseDate,
  shortDateTime,
  timeOnly,
  type Tone,
} from "@/lib/format";
import type {
  AuditEvent,
  StepStatus,
  ToolCallStatus,
  WorkflowStatus,
} from "@/lib/types";

/* --------------------------------------------------------------------------
   Sources — each origin gets its own tone and mark, so the eye can skim for
   one kind of event without reading a word.
   -------------------------------------------------------------------------- */
type SourceFilter = "all" | "step" | "tool_call" | "approval" | "system";

const SOURCE_META: Record<string, { label: string; tone: Tone; icon: LucideIcon }> = {
  step: { label: "Step", tone: "brand", icon: ListChecks },
  tool_call: { label: "Tool call", tone: "neutral", icon: Wrench },
  approval: { label: "Approval", tone: "warning", icon: ShieldCheck },
  system: { label: "System", tone: "muted", icon: Server },
};

function sourceMeta(source: string) {
  return (
    SOURCE_META[source] ?? {
      label: humanise(source),
      tone: "neutral" as Tone,
      icon: CircleDot,
    }
  );
}

/**
 * A status on this page can be a step status, a tool-call status, an
 * approval decision or a workflow status — the union is over four tables.
 * Each goes through its own vocabulary rather than being printed raw.
 */
function statusMeta(source: string, status: string): { label: string; tone: Tone } {
  if (source === "step" && status in STEP_STATUS_LABEL) {
    const key = status as StepStatus;
    return { label: STEP_STATUS_LABEL[key], tone: STEP_STATUS_TONE[key] };
  }
  if (source === "tool_call" && status in TOOL_STATUS_TONE) {
    const key = status as ToolCallStatus;
    return { label: humanise(status), tone: TOOL_STATUS_TONE[key] };
  }
  if (source === "approval") {
    const tone: Tone =
      status === "approved" ? "positive" : status === "rejected" ? "danger" : "warning";
    return { label: humanise(status), tone };
  }
  if (status in WORKFLOW_STATUS_LABEL) {
    const key = status as WorkflowStatus;
    return { label: WORKFLOW_STATUS_LABEL[key], tone: WORKFLOW_STATUS_TONE[key] };
  }
  return { label: humanise(status), tone: "neutral" };
}

/** The tool-call rows carry "ok" as their detail when nothing went wrong —
 *  the status pill already says that, so the line is dropped rather than
 *  repeated. */
function readableDetail(event: AuditEvent): string | null {
  if (!event.detail) return null;
  if (event.source === "tool_call" && event.detail.trim().toLowerCase() === "ok") {
    return null;
  }
  return event.detail;
}

function actorLabel(actor: string): string {
  return actor === "agent" ? "Agent" : humanise(actor);
}

/* --------------------------------------------------------------------------
   Pieces
   -------------------------------------------------------------------------- */
function SourceBadge({ source }: { source: string }) {
  const meta = sourceMeta(source);
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em]",
        TONE_PILL[meta.tone],
      )}
    >
      <Icon className="size-3" strokeWidth={2.2} />
      {meta.label}
    </span>
  );
}

/** The agent's own marker is the avatar gradient — a person's is not. */
function ActorMarker({ actor }: { actor: string }) {
  if (actor === "agent") {
    return (
      <span
        className="gradient-avatar grid size-8 shrink-0 place-items-center rounded-full text-white shadow-[0_6px_16px_rgba(46,96,120,0.24)]"
        title="Acted autonomously by the agent"
      >
        <Sparkles className="size-[15px]" strokeWidth={2.2} />
      </span>
    );
  }
  return (
    <span
      className="grid size-8 shrink-0 place-items-center rounded-full border border-[#d3e2e9] bg-white text-[#7e8c94]"
      title="Acted by a person"
    >
      <User className="size-[15px]" strokeWidth={2.2} />
    </span>
  );
}

function EventNode({ event, last }: { event: AuditEvent; last: boolean }) {
  const detail = readableDetail(event);
  const status = event.status ? statusMeta(event.source, event.status) : null;

  return (
    <li className="relative flex gap-3 sm:gap-4">
      {/* Left rail: the clock. Hidden on a phone, where it moves inline. */}
      <span className="tnum hidden w-[64px] shrink-0 pt-[7px] text-right font-mono text-[11.5px] text-[#7e8c94] sm:block">
        {timeOnly(event.at)}
      </span>

      {/* Middle rail: the marker and the thread between events. */}
      <div className="flex shrink-0 flex-col items-center">
        <ActorMarker actor={event.actor} />
        {!last && <span className="mt-1.5 w-px flex-1 bg-[#e0ebf0]" />}
      </div>

      <div
        className={cn(
          "min-w-0 flex-1 rounded-[16px] p-3 transition-colors duration-200",
          !last && "mb-3",
          "hover:bg-white/55",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="tnum font-mono text-[11px] text-[#7e8c94] sm:hidden">
            {timeOnly(event.at)}
          </span>
          <SourceBadge source={event.source} />
          <span className="text-[11.5px] font-medium text-[#7e8c94]">
            {actorLabel(event.actor)}
          </span>
          {event.duration_ms != null && (
            <span className="tnum ml-auto shrink-0 font-mono text-[11.5px] text-[#5f7280]">
              {duration(event.duration_ms)}
            </span>
          )}
        </div>

        <p className="mt-2 text-[13.5px] font-semibold leading-snug tracking-[-0.01em] text-[#243640]">
          {event.event}
        </p>

        {detail && (
          <p className="mt-1 max-w-[80ch] text-[12.5px] leading-relaxed text-[#5f7280]">
            {detail}
          </p>
        )}

        {(status || event.reference_id) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {status && <StatusPill label={status.label} tone={status.tone} size="sm" />}
            {event.reference_id && (
              <span
                className="flex items-center gap-1"
                title={event.reference_id}
              >
                <Mono className="text-[11px]">
                  {event.reference_id.slice(0, 8)}…
                </Mono>
                <CopyButton value={event.reference_id} label="Copy id" />
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/* --------------------------------------------------------------------------
   Page
   -------------------------------------------------------------------------- */
export default function AuditTrailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [source, setSource] = useState<SourceFilter>("all");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["workflow", id, "audit"],
    queryFn: () => api.getAudit(id),
  });

  // The API already sorts ascending; sorting again keeps the day grouping
  // correct even if a future source is appended out of order.
  const events = useMemo(() => {
    const list = [...(data ?? [])];
    list.sort(
      (a, b) =>
        (parseDate(a.at)?.getTime() ?? 0) - (parseDate(b.at)?.getTime() ?? 0),
    );
    return list;
  }, [data]);

  const counts = useMemo(() => {
    const tally: Record<SourceFilter, number> = {
      all: events.length,
      step: 0,
      tool_call: 0,
      approval: 0,
      system: 0,
    };
    for (const event of events) {
      if (event.source === "step") tally.step += 1;
      else if (event.source === "tool_call") tally.tool_call += 1;
      else if (event.source === "approval") tally.approval += 1;
      else if (event.source === "system") tally.system += 1;
    }
    return tally;
  }, [events]);

  const filtered = useMemo(
    () => (source === "all" ? events : events.filter((e) => e.source === source)),
    [events, source],
  );

  const days = useMemo(() => {
    const groups: { key: string; events: AuditEvent[] }[] = [];
    for (const event of filtered) {
      const key = dateOnly(event.at);
      const current = groups[groups.length - 1];
      if (current && current.key === key) current.events.push(event);
      else groups.push({ key, events: [event] });
    }
    return groups;
  }, [filtered]);

  const notReady = error instanceof ApiError && error.isNotFound;
  const forbidden = error instanceof ApiError && error.isForbidden;

  const filterOptions: { value: SourceFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: counts.all },
    { value: "step", label: "Steps", count: counts.step },
    { value: "tool_call", label: "Tool calls", count: counts.tool_call },
    { value: "approval", label: "Approvals", count: counts.approval },
    { value: "system", label: "System", count: counts.system },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit trail"
        description="Every recorded event on this workflow, oldest first — steps, tool calls, approvals and system events on one thread."
      />

      <WorkflowNav workflowId={id} />

      {isLoading && (
        <Card>
          <LoadingBlock rows={5} />
        </Card>
      )}

      {/* -------------------------------------------------------------------
          A 404 here is never "not recorded yet": the trail is a view over the
          workflow's own rows, and creating the workflow is itself the first
          event, so any visible workflow has a trail. The only 404 is a
          workflow this account cannot see, and the only 403 is a vendor
          account reaching for a buyer workflow. Neither becomes true by
          asking again, so the way out is a link rather than a retry.
          ------------------------------------------------------------------- */}
      {!isLoading && notReady && (
        <EmptyState
          icon={<SearchX className="size-6" />}
          title="No such workflow"
          description="Nothing with this reference is visible to your account. Employees see the runs they raised; administrators see every run in the organisation."
          action={
            <Link
              href="/workflows"
              className="inline-flex h-10 items-center gap-2 rounded-[14px] border border-white/80 bg-white/75 px-4 text-[13px] font-semibold text-[#243640] shadow-[0_8px_22px_rgba(46,96,120,0.10)] transition-colors duration-200 hover:bg-white/95"
            >
              Browse workflows
            </Link>
          }
        />
      )}

      {!isLoading && forbidden && (
        <EmptyState
          icon={<Lock className="size-6" />}
          title="Vendor accounts cannot open buyer workflows"
          description="An audit trail belongs to the requesting organisation. Your vendor portal holds the catalog you publish and the purchase orders raised with you."
          action={
            <Link
              href="/portal"
              className="inline-flex h-10 items-center gap-2 rounded-[14px] border border-white/80 bg-white/75 px-4 text-[13px] font-semibold text-[#243640] shadow-[0_8px_22px_rgba(46,96,120,0.10)] transition-colors duration-200 hover:bg-white/95"
            >
              Open the vendor portal
            </Link>
          }
        />
      )}

      {!isLoading && error && !notReady && !forbidden && (
        <ErrorState error={error} onRetry={() => void refetch()} />
      )}

      {!isLoading && !error && data && events.length === 0 && (
        <EmptyState
          icon={<ScrollText className="size-6" />}
          title="Nothing has been recorded yet"
          description="Events are written as the agent executes. Run this workflow and every step, tool call and approval will appear here in order."
        />
      )}

      {!isLoading && !error && events.length > 0 && (
        <>
          <Card className="animate-fade-up">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
                  Execution events
                </h2>
                <p className="tnum mt-1 text-[12.5px] text-[#7e8c94]">
                  {counts.all} {counts.all === 1 ? "event" : "events"} ·{" "}
                  {shortDateTime(events[0].at)} →{" "}
                  {shortDateTime(events[events.length - 1].at)}
                </p>
              </div>
              <ChipGroup
                options={filterOptions}
                value={source}
                onChange={setSource}
              />
            </div>

            {filtered.length === 0 ? (
              <EmptyState
                title="No events of that kind"
                description="This workflow recorded nothing from that source. The other filters still have events."
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setSource("all")}
                  >
                    Show everything
                  </Button>
                }
              />
            ) : (
              <div className="space-y-8">
                {days.map((day, dayIndex) => (
                  <section key={`${day.key}-${dayIndex}`}>
                    {/* The day heading follows you down a long trail. */}
                    <div className="sticky top-[72px] z-20 mb-4 flex">
                      <span className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/85 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[#5f7280] shadow-[0_4px_14px_rgba(46,96,120,0.10)] backdrop-blur-md">
                        <CalendarDays className="size-3.5" strokeWidth={2.2} />
                        {day.key}
                        <span className="tnum font-semibold text-[#a3b6c0]">
                          {day.events.length}
                        </span>
                      </span>
                    </div>

                    <ol>
                      {day.events.map((event, index) => (
                        <EventNode
                          key={`${event.at}-${event.reference_id ?? index}`}
                          event={event}
                          last={
                            dayIndex === days.length - 1 &&
                            index === day.events.length - 1
                          }
                        />
                      ))}
                    </ol>
                  </section>
                ))}
              </div>
            )}
          </Card>

          <p className="flex max-w-[70ch] items-start gap-2 text-[12px] leading-relaxed text-[#7e8c94]">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              This trail is assembled as a union over the workflow&rsquo;s
              steps, tool calls and approvals — it is not duplicated into an
              audit table of its own. Nothing writes to it separately, so it
              can never disagree with what actually executed. The reference on
              each event is the primary key of the record it came from.
            </span>
          </p>
        </>
      )}
    </div>
  );
}
