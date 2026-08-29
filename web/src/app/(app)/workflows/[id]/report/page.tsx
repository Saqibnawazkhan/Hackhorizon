"use client";

/**
 * Screen 9a — the completion report.
 *
 * A plain-language account of a finished run, written for somebody who was
 * not watching it happen. The backend assembles this from the execution
 * trace itself — the steps, the tool calls, the quotes, the purchase order —
 * so nothing on this page is a summary of a summary. `metrics[].value`
 * arrives pre-formatted for exactly that reason and is rendered verbatim;
 * the exception is a bare status enum — in a metric, in the headline, or at
 * the tail of a step bullet — which goes through the shared label maps so
 * the page never shows "awaiting_approval" to a human.
 *
 * The report is a document. It prints.
 */
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  FileText,
  Lightbulb,
  Lock,
  Printer,
  SearchX,
} from "lucide-react";
import Link from "next/link";
import { use } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  Mono,
  Skeleton,
  cn,
} from "@/components/ui";
import { WorkflowNav } from "@/components/workflow/WorkflowNav";
import { ApiError, api } from "@/lib/api";
import {
  STEP_STATUS_LABEL,
  WORKFLOW_STATUS_LABEL,
  dateTime,
  duration,
  number as fmtNumber,
} from "@/lib/format";
import type {
  ReportMetric,
  ReportSection,
  StepStatus,
  WorkflowStatus,
} from "@/lib/types";

/* --------------------------------------------------------------------------
   Status copy

   Three fields can arrive carrying a raw enum: the "Status" metric, the tail
   of the headline the API composes as "<title> — <status>", and every bullet
   of the "What the agent did" section, which the service builds as
   "<step title> — <step status> (<ms>ms)". All three go through the shared
   label maps rather than being printed as they are. Everything else in
   `value` is already formatted and is left untouched.
   -------------------------------------------------------------------------- */
const WORKFLOW_STATUS_VALUES = Object.keys(
  WORKFLOW_STATUS_LABEL,
) as WorkflowStatus[];

function asWorkflowStatus(value: string): WorkflowStatus | null {
  const trimmed = value.trim();
  return WORKFLOW_STATUS_VALUES.find((status) => status === trimmed) ?? null;
}

function readableValue(value: string): string {
  const status = asWorkflowStatus(value);
  return status ? WORKFLOW_STATUS_LABEL[status] : value;
}

function statusLabel(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed in STEP_STATUS_LABEL) {
    return STEP_STATUS_LABEL[trimmed as StepStatus];
  }
  const workflowStatus = asWorkflowStatus(trimmed);
  return workflowStatus ? WORKFLOW_STATUS_LABEL[workflowStatus] : null;
}

function readableHeadline(headline: string): string {
  const split = headline.lastIndexOf(" — ");
  if (split === -1) return headline;
  const status = asWorkflowStatus(headline.slice(split + 3));
  if (!status) return headline;
  return `${headline.slice(0, split)} — ${WORKFLOW_STATUS_LABEL[status]}`;
}

/**
 * "Fetch quotes — retrying (81234ms)" → "Fetch quotes — Auto-retrying · 1m 21s".
 *
 * A bullet that does not end in a known status is left exactly as the API
 * wrote it: the "Decision" section's bullets are prose, and mangling them
 * would be worse than leaving a lowercase word alone.
 */
const STEP_BULLET = /^(.*) — ([a-z_]+)(?: \((\d+)ms\))?$/;

function readableBullet(bullet: string): string {
  const match = STEP_BULLET.exec(bullet);
  if (!match) return bullet;
  const [, prefix, rawStatus, ms] = match;
  const label = statusLabel(rawStatus);
  if (!label) return bullet;
  return ms
    ? `${prefix} — ${label} · ${duration(Number(ms))}`
    : `${prefix} — ${label}`;
}

/* --------------------------------------------------------------------------
   Pieces
   -------------------------------------------------------------------------- */
function MetricTile({ metric }: { metric: ReportMetric }) {
  const emphasis = metric.emphasis === true;
  return (
    <div
      className={cn(
        "rounded-[24px] p-5 transition-shadow duration-200",
        emphasis ? "glass" : "glass-flat",
      )}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
        {metric.label}
      </p>
      <p
        className={cn(
          "tnum mt-3 font-bold leading-none tracking-[-0.03em]",
          emphasis
            ? "text-[30px] text-[#38677b]"
            : "text-[22px] text-[#243640]",
        )}
      >
        {readableValue(metric.value)}
      </p>
      {emphasis && (
        <span className="gradient-cta mt-4 block h-[3px] w-10 rounded-full" />
      )}
    </div>
  );
}

function ReportSectionBlock({ section }: { section: ReportSection }) {
  return (
    <section>
      <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
        {section.heading}
      </h3>
      {section.body && (
        <p className="mt-2.5 max-w-[70ch] whitespace-pre-line text-[13.5px] leading-[1.75] text-[#4a5c66]">
          {section.body}
        </p>
      )}
      {section.bullets.length > 0 && (
        <ul className="mt-4 max-w-[70ch] space-y-2.5">
          {section.bullets.map((bullet, index) => (
            <li
              key={`${bullet}-${index}`}
              className="flex gap-3 text-[13px] leading-relaxed text-[#4a5c66]"
            >
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[#b9d8e1]" />
              <span className="min-w-0">{readableBullet(bullet)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FooterFigure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
        {label}
      </p>
      <p className="tnum mt-1.5 text-[14px] font-semibold text-[#243640]">
        {value}
      </p>
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-[176px] rounded-[28px]" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-[124px] rounded-[24px]" />
        ))}
      </div>
      <Skeleton className="h-[280px] rounded-[28px]" />
    </div>
  );
}

/* --------------------------------------------------------------------------
   Page
   -------------------------------------------------------------------------- */
export default function CompletionReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["workflow", id, "report"],
    queryFn: () => api.getReport(id),
  });

  const notReady = error instanceof ApiError && error.isNotFound;
  const forbidden = error instanceof ApiError && error.isForbidden;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Completion report"
        description="What the agent did, in plain language — assembled from the execution trace rather than written after the fact."
        actions={
          data ? (
            <Button
              variant="secondary"
              icon={<Printer className="size-4" />}
              onClick={() => window.print()}
              className="no-print"
            >
              Print
            </Button>
          ) : undefined
        }
      />

      <WorkflowNav workflowId={id} />

      {isLoading && <ReportSkeleton />}

      {/* -------------------------------------------------------------------
          A 404 here is never "not generated yet": the service composes the
          report from whatever the run has recorded, so it answers for a draft
          as readily as for a finished workflow. The only 404 is a workflow
          this account cannot see, and the only 403 is a vendor account
          reaching for a buyer workflow. Neither improves by asking again, so
          the way out is a link rather than a retry button.
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
          description="Completion reports belong to the requesting organisation. Your vendor portal holds the catalog you publish and the purchase orders raised with you."
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

      {!isLoading && !error && data && (
        <div className="space-y-6">
          {/* ---------------------------------------------------------------
              Headline — the one sentence somebody who missed the run needs.
              --------------------------------------------------------------- */}
          <Card className="animate-fade-up relative overflow-hidden">
            <span
              className="gradient-cta absolute inset-x-0 top-0 h-1"
              aria-hidden
            />
            <h2 className="max-w-[38ch] text-[28px] font-bold leading-[1.18] tracking-[-0.03em] text-[#243640]">
              {readableHeadline(data.headline)}
            </h2>
            <p className="mt-3 text-[13.5px] leading-relaxed text-[#5f7280]">
              {data.title}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#e7eff3] pt-4 text-[12px] text-[#7e8c94]">
              <span>Generated {dateTime(data.generated_at)}</span>
              <span className="hidden text-[#cfdde4] sm:inline">·</span>
              {/* The full uuid is 36 unbreakable characters — it does not fit
                  a 390px card, and nobody reads one. The short form is what
                  every other screen shows; Copy hands over the whole thing. */}
              <span className="flex items-center gap-1.5">
                Workflow
                <Mono>{data.workflow_id.slice(0, 8)}</Mono>
                <span className="no-print">
                  <CopyButton value={data.workflow_id} label="Copy id" />
                </span>
              </span>
            </div>
          </Card>

          {/* ---------------------------------------------------------------
              Metrics. `value` is already formatted by the API — the tiles
              only decide typographic weight, never the number.
              --------------------------------------------------------------- */}
          {data.metrics.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {data.metrics.map((metric, index) => (
                <MetricTile key={`${metric.label}-${index}`} metric={metric} />
              ))}
            </div>
          )}

          {/* ---------------------------------------------------------------
              The narrative.
              --------------------------------------------------------------- */}
          {data.sections.length > 0 && (
            <Card className="space-y-8">
              {data.sections.map((section, index) => (
                <div key={`${section.heading}-${index}`}>
                  {index > 0 && (
                    <hr className="mb-8 border-0 border-t border-[#e7eff3]" />
                  )}
                  <ReportSectionBlock section={section} />
                </div>
              ))}
            </Card>
          )}

          {/* ---------------------------------------------------------------
              The transparency claim, made concrete.
              --------------------------------------------------------------- */}
          <Card>
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-white/70 text-[#447f98] shadow-[0_4px_12px_rgba(46,96,120,0.10)]">
                <Lightbulb className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
                  Every autonomous decision the agent made
                </h3>
                <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-[#7e8c94]">
                  These are the choices made without asking anyone. Each one
                  was recorded by the step that produced it, as it ran — none
                  of it is reconstructed afterwards. The purchase itself was
                  not among them: that stopped at a human.
                </p>
              </div>
            </div>

            {data.decisions.length > 0 ? (
              <ol className="mt-6 grid gap-3 md:grid-cols-2">
                {data.decisions.map((decision, index) => (
                  <li
                    key={`${decision}-${index}`}
                    className="glass-flat flex items-start gap-4 rounded-[20px] p-4 transition-shadow duration-200 hover:shadow-[0_10px_26px_rgba(46,96,120,0.12)]"
                  >
                    <span className="gradient-avatar tnum grid size-9 shrink-0 place-items-center rounded-full text-[12.5px] font-bold text-white shadow-[0_6px_16px_rgba(46,96,120,0.24)]">
                      {index + 1}
                    </span>
                    <p className="min-w-0 pt-1.5 text-[13px] leading-relaxed text-[#243640]">
                      {decision}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-6 rounded-[20px] border border-dashed border-[#cfe0e8] bg-white/40 px-4 py-5 text-[12.5px] leading-relaxed text-[#7e8c94]">
                No step on this run recorded a decision summary. That happens
                when the workflow stopped before the agent reached a choice —
                the execution timeline still shows every step it did take.
              </p>
            )}
          </Card>

          {/* ---------------------------------------------------------------
              Caveats — surfaced, not buried.

              `plain`, not `glass`: the glass utility sets its own
              background-image, background-color and border shorthand, which
              would wash the warning tint straight back out to white.
              --------------------------------------------------------------- */}
          {data.caveats.length > 0 && (
            <Card variant="plain" className="border-[#fedf89] bg-[#fffaeb]/70">
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-[#fffaeb] text-[#b54708]">
                  <AlertTriangle className="size-[18px]" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[#93370d]">
                    What the agent could not verify
                  </h3>
                  <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-[#b54708]">
                    The agent reports the limits of its own evidence rather
                    than hiding them. Nothing below invalidates the run — it is
                    what a person should check before relying on it.
                  </p>
                  <ul className="mt-4 space-y-2.5">
                    {data.caveats.map((caveat, index) => (
                      <li
                        key={`${caveat}-${index}`}
                        className="flex gap-3 text-[13px] leading-relaxed text-[#93370d]"
                      >
                        <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[#f79009]" />
                        <span className="min-w-0">{caveat}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
          )}

          {/* ---------------------------------------------------------------
              The run, in figures.
              --------------------------------------------------------------- */}
          <Card variant="flat" padded={false} className="p-5">
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">
              <FooterFigure
                label="Steps executed"
                value={fmtNumber(data.steps_executed)}
              />
              <FooterFigure
                label="Tools invoked"
                value={fmtNumber(data.tools_invoked)}
              />
              <FooterFigure
                label="Retries performed"
                value={fmtNumber(data.retries_performed)}
              />
              <FooterFigure
                label="Total duration"
                value={duration(data.total_duration_ms)}
              />
              <FooterFigure
                label="Generated"
                value={dateTime(data.generated_at)}
              />
            </div>
          </Card>

          <p className="flex max-w-[70ch] items-start gap-2 text-[12px] leading-relaxed text-[#7e8c94]">
            <FileText className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Every figure above is read back from the run that actually
              happened. If a step never executed, it is not counted here.
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
