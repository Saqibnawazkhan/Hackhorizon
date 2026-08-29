"use client";

/**
 * The live execution stepper — screens 4a and 4b.
 *
 * Each step is a node on a rail. A running step breathes; a retrying step
 * (4b) says which attempt it is on and why; a failed step keeps its error
 * where it happened rather than pushing it into a toast that disappears.
 *
 * The tool log under each step is the receipt: every invocation, successes
 * and failures alike, with its duration and retry count.
 */
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDashed,
  RotateCw,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";

import { StatusPill, cn } from "@/components/ui";
import {
  STEP_STATUS_LABEL,
  STEP_STATUS_TONE,
  TOOL_STATUS_TONE,
  duration as fmtDuration,
  humanise,
} from "@/lib/format";
import type { WorkflowStep } from "@/lib/types";

function StepIcon({ status }: { status: WorkflowStep["status"] }) {
  const base =
    "grid size-8 shrink-0 place-items-center rounded-full border-2 bg-white transition-all duration-300";
  switch (status) {
    case "completed":
      return (
        <span className={cn(base, "border-[#17b26a] text-[#17b26a]")}>
          <Check className="size-4" strokeWidth={3} />
        </span>
      );
    case "running":
      return (
        <span
          className={cn(
            base,
            "animate-pulse-ring gradient-cta border-transparent text-white",
          )}
        >
          <span className="size-2 rounded-full bg-white" />
        </span>
      );
    case "retrying":
      return (
        <span className={cn(base, "border-[#f79009] text-[#b54708]")}>
          <RotateCw className="size-4 animate-spin" strokeWidth={2.5} />
        </span>
      );
    case "failed":
      return (
        <span className={cn(base, "border-[#f04438] text-[#b42318]")}>
          <X className="size-4" strokeWidth={3} />
        </span>
      );
    case "skipped":
      return (
        <span className={cn(base, "border-[#d3e2e9] text-[#a9bac3]")}>
          <CircleDashed className="size-4" />
        </span>
      );
    default:
      return (
        <span className={cn(base, "border-[#d3e2e9] text-[#a9bac3]")}>
          <span className="size-2 rounded-full bg-[#cfdde4]" />
        </span>
      );
  }
}

export function ExecutionTimeline({
  steps,
  className,
  defaultExpandRunning = true,
}: {
  steps: WorkflowStep[];
  className?: string;
  defaultExpandRunning?: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isExpanded = (step: WorkflowStep) => {
    if (step.id in expanded) return expanded[step.id];
    // A running step, and anything that went wrong, opens itself: those are
    // the two cases where the detail is the whole point.
    if (defaultExpandRunning && (step.status === "running" || step.status === "retrying")) {
      return true;
    }
    return step.status === "failed";
  };

  if (steps.length === 0) {
    return (
      <p className="py-8 text-center text-[13px] text-[#7e8c94]">
        No steps have been recorded yet.
      </p>
    );
  }

  return (
    <ol className={cn("relative space-y-1", className)}>
      {steps.map((step, index) => {
        const open = isExpanded(step);
        const last = index === steps.length - 1;
        const hasDetail = step.tool_calls.length > 0 || !!step.error || !!step.description;

        return (
          <li key={step.id} className="relative flex gap-4">
            {/* Rail */}
            <div className="flex flex-col items-center">
              <StepIcon status={step.status} />
              {!last && (
                <span
                  className={cn(
                    "w-0.5 flex-1 rounded-full transition-colors duration-500",
                    step.status === "completed" ? "bg-[#a6f4c5]" : "bg-[#e0ebf0]",
                  )}
                  style={{ minHeight: 18 }}
                />
              )}
            </div>

            {/* Body */}
            <div className={cn("min-w-0 flex-1", last ? "pb-1" : "pb-5")}>
              <button
                type="button"
                disabled={!hasDetail}
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [step.id]: !open }))
                }
                className={cn(
                  "flex w-full items-start justify-between gap-3 rounded-[14px] px-3 py-2 text-left transition-colors",
                  hasDetail && "hover:bg-white/60",
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10.5px] font-bold tabular-nums text-[#a3b6c0]">
                      {String(step.step_order).padStart(2, "0")}
                    </span>
                    <span className="text-[13.5px] font-semibold text-[#243640]">
                      {step.title}
                    </span>
                    <StatusPill
                      size="sm"
                      label={STEP_STATUS_LABEL[step.status]}
                      tone={STEP_STATUS_TONE[step.status]}
                    />
                    {step.retry_count > 0 && (
                      <span className="text-[10.5px] font-semibold text-[#b54708]">
                        attempt {step.retry_count + 1} of {step.max_retries + 1}
                      </span>
                    )}
                  </div>
                  {step.description && (
                    <p className="mt-0.5 line-clamp-1 text-[12px] text-[#7e8c94]">
                      {step.description}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {step.duration_ms !== null && (
                    <span className="text-[11px] tabular-nums text-[#a3b6c0]">
                      {fmtDuration(step.duration_ms)}
                    </span>
                  )}
                  {hasDetail && (
                    <ChevronDown
                      className={cn(
                        "size-4 text-[#a9bac3] transition-transform duration-200",
                        open && "rotate-180",
                      )}
                    />
                  )}
                </div>
              </button>

              {open && hasDetail && (
                <div className="animate-fade-in ml-3 mt-1 space-y-2 border-l-2 border-[#e7eff3] pl-4">
                  {step.error && (
                    <div className="flex items-start gap-2 rounded-[12px] border border-[#fecdca] bg-[#fef3f2] px-3 py-2">
                      <AlertTriangle className="mt-px size-3.5 shrink-0 text-[#b42318]" />
                      <p className="text-[12px] leading-relaxed text-[#b42318]">
                        {step.error}
                      </p>
                    </div>
                  )}

                  {step.tool_calls.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#a3b6c0]">
                        Tool log
                      </p>
                      {step.tool_calls.map((call) => (
                        <div
                          key={call.id}
                          className="flex items-center gap-2.5 rounded-[10px] bg-white/60 px-2.5 py-1.5"
                        >
                          <Wrench className="size-3 shrink-0 text-[#93a7b1]" />
                          <span className="truncate font-mono text-[11.5px] text-[#38677b]">
                            {call.tool_name}
                          </span>
                          <StatusPill
                            size="sm"
                            dot={false}
                            label={humanise(call.status)}
                            tone={TOOL_STATUS_TONE[call.status] ?? "neutral"}
                          />
                          {call.retry_count > 0 && (
                            <span className="text-[10.5px] text-[#b54708]">
                              {call.retry_count} retr{call.retry_count === 1 ? "y" : "ies"}
                            </span>
                          )}
                          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[#a3b6c0]">
                            {fmtDuration(call.duration_ms)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The plan, before anything has executed — screen 3a. */
export function PlanPreview({
  steps,
  className,
}: {
  steps: { order: number; title: string; description: string; tool_name?: string | null }[];
  className?: string;
}) {
  return (
    <ol className={cn("space-y-1", className)}>
      {steps.map((step, index) => (
        <li key={step.order} className="flex gap-4">
          <div className="flex flex-col items-center">
            <span className="grid size-8 shrink-0 place-items-center rounded-full border-2 border-[#d3e2e9] bg-white text-[11.5px] font-bold tabular-nums text-[#5f7280]">
              {step.order}
            </span>
            {index < steps.length - 1 && (
              <span className="w-0.5 flex-1 rounded-full bg-[#e0ebf0]" style={{ minHeight: 14 }} />
            )}
          </div>
          <div className={cn("min-w-0 flex-1", index < steps.length - 1 && "pb-4")}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[13.5px] font-semibold text-[#243640]">{step.title}</p>
              {step.tool_name && (
                <span className="rounded-[6px] bg-[#e9f3f8] px-1.5 py-0.5 font-mono text-[10.5px] text-[#38677b]">
                  {step.tool_name}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-[#7e8c94]">
              {step.description}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
