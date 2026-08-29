"use client";

/**
 * Validation report — design screens 6a (pass) and 6b (fail).
 *
 * This is the screen that proves the agent checks its own work. `validate_po`
 * compares the generated purchase order against the QUOTE SNAPSHOT it was
 * generated from — never the live catalog — using deterministic Python, so a
 * failure here is reproducible rather than a model's opinion.
 *
 * The checks array is deliberately loosely typed: the backend persists
 * `checks_json` verbatim, so a check may carry `title` or `name`, `outcome` or
 * `passed`, `detail` or `message`. Everything below reads both shapes.
 *
 * When `attempt > 1` the interesting thing has already happened: the agent read
 * its own failure, went back to `generate_po` and rebuilt the document. That
 * loop is bounded by AGENT_MAX_SELF_CORRECTION_ATTEMPTS, and when the budget
 * runs out the run escalates to a person rather than shipping a wrong order.
 */
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  FileSearch,
  Lock,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  UserRoundCheck,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { use } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Mono,
  Panel,
  StatusPill,
  cn,
} from "@/components/ui";
import { WorkflowNav } from "@/components/workflow/WorkflowNav";
import { ApiError, api } from "@/lib/api";
import { dateTime, humanise, relativeTime, type Tone } from "@/lib/format";
import type { ValidationCheck } from "@/lib/types";

/* --------------------------------------------------------------------------
   Reading a loosely-shaped check
   -------------------------------------------------------------------------- */
type Verdict = "passed" | "failed" | "warning";

function verdictOf(check: ValidationCheck): Verdict {
  if (
    check.outcome === "passed" ||
    check.outcome === "failed" ||
    check.outcome === "warning"
  ) {
    return check.outcome;
  }
  if (check.passed === true) return "passed";
  if (check.passed === false) return "failed";
  // Neither field present: say "warning" rather than inventing a pass.
  return "warning";
}

function titleOf(check: ValidationCheck): string {
  // `check` is the live machine key; `check_type` is only the legacy alias a
  // stored report from an earlier validator version carries.
  return check.title ?? check.name ?? humanise(check.check ?? check.check_type);
}

function detailOf(check: ValidationCheck): string | null {
  // The live payload writes the prose into `message`; `detail` is the legacy
  // spelling, so it is the fallback rather than the preference.
  return check.message ?? check.detail ?? null;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  passed: "Passed",
  failed: "Failed",
  warning: "Warning",
};

const VERDICT_TONE: Record<Verdict, Tone> = {
  passed: "positive",
  failed: "danger",
  warning: "warning",
};

const VERDICT_ICON_CLASS: Record<Verdict, string> = {
  passed: "border-[#a6f4c5] bg-[#ecfdf3] text-[#067647]",
  failed: "border-[#fecdca] bg-[#fef3f2] text-[#b42318]",
  warning: "border-[#fedf89] bg-[#fffaeb] text-[#b54708]",
};

const MICRO = "text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]";

/** The quiet pill link used for "go and look at the thing that does exist". */
const PILL_LINK =
  "inline-flex items-center gap-1.5 rounded-[12px] bg-[#e9f3f8] px-3 py-2 " +
  "text-[12.5px] font-semibold text-[#38677b] transition-colors duration-200 hover:bg-[#d6ebf3]";

/* --------------------------------------------------------------------------
   One check
   -------------------------------------------------------------------------- */
function CheckRow({ check }: { check: ValidationCheck }) {
  const verdict = verdictOf(check);
  const detail = detailOf(check);
  const hasComparison =
    (check.expected !== null && check.expected !== undefined) ||
    (check.actual !== null && check.actual !== undefined);

  return (
    <li className="flex gap-3.5 px-6 py-4 transition-colors duration-200 hover:bg-white/55">
      <span
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-[12px] border",
          VERDICT_ICON_CLASS[verdict],
        )}
        aria-hidden
      >
        {verdict === "passed" ? (
          <CheckCircle2 className="size-4" strokeWidth={2.2} />
        ) : verdict === "failed" ? (
          <XCircle className="size-4" strokeWidth={2.2} />
        ) : (
          <AlertTriangle className="size-4" strokeWidth={2.2} />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <p className="text-[13.5px] font-semibold tracking-[-0.01em] text-[#243640]">
            {titleOf(check)}
          </p>
          <StatusPill
            size="sm"
            dot={false}
            tone={VERDICT_TONE[verdict]}
            label={VERDICT_LABEL[verdict]}
          />
        </div>

        {detail && (
          <p className="mt-1 text-[12.5px] leading-relaxed text-[#5f7280]">{detail}</p>
        )}

        {hasComparison && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="glass-flat rounded-[14px] px-3.5 py-2.5">
              <p className={MICRO}>Expected</p>
              <p className="tnum mt-1 break-words text-[12.5px] font-semibold text-[#243640]">
                {check.expected ?? "Not specified"}
              </p>
            </div>
            <div
              className={cn(
                "rounded-[14px] px-3.5 py-2.5",
                verdict === "failed"
                  ? "border border-[#fecdca] bg-[#fef3f2]"
                  : "glass-flat",
              )}
            >
              <p className={MICRO}>Actual</p>
              <p
                className={cn(
                  "tnum mt-1 break-words text-[12.5px] font-semibold",
                  verdict === "failed" ? "text-[#b42318]" : "text-[#243640]",
                )}
              >
                {check.actual ?? "Not specified"}
              </p>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

/* --------------------------------------------------------------------------
   The attempt ladder — what the correction budget was spent on
   -------------------------------------------------------------------------- */
function AttemptLadder({
  attempt,
  maxAttempts,
  passed,
}: {
  attempt: number;
  maxAttempts: number;
  passed: boolean;
}) {
  // Capped so an absurd budget cannot produce an endless ladder, but never so
  // tightly that the attempt actually being reported falls off the bottom.
  const rows = Math.min(
    Math.max(maxAttempts, attempt, 1),
    Math.max(attempt + 1, 8),
  );
  const exhausted = attempt >= maxAttempts;

  return (
    <ol className="space-y-2">
      {Array.from({ length: rows }, (_, index) => index + 1).map((n) => {
        const spent = n < attempt;
        const current = n === attempt;

        const tone: Tone = spent
          ? "warning"
          : current
            ? passed
              ? "positive"
              : "danger"
            : "muted";

        const heading = spent
          ? `Attempt ${n} — failed validation`
          : current
            ? passed
              ? `Attempt ${n} — passed`
              : exhausted
                ? `Attempt ${n} — failed, budget exhausted`
                : `Attempt ${n} — failed`
            : `Attempt ${n} — ${passed ? "not needed" : "still available"}`;

        const body = spent
          ? "The agent rejected its own document and returned to generate_po."
          : current
            ? passed
              ? "This is the purchase order the checks below describe."
              : exhausted
                ? "No regeneration left. The run was handed to a human."
                : "A further regeneration is permitted by the budget."
            : passed
              ? "The budget allowed it; the agent did not need it."
              : "Held in reserve by the correction budget.";

        return (
          <li
            key={n}
            className={cn(
              "flex items-start gap-3 rounded-[16px] border px-3.5 py-2.5",
              tone === "warning" && "border-[#fedf89] bg-[#fffaeb]",
              tone === "positive" && "border-[#a6f4c5] bg-[#ecfdf3]",
              tone === "danger" && "border-[#fecdca] bg-[#fef3f2]",
              tone === "muted" && "border-dashed border-[#dce9ef] bg-white/45",
            )}
          >
            <span
              className={cn(
                "mt-px shrink-0",
                tone === "warning" && "text-[#b54708]",
                tone === "positive" && "text-[#067647]",
                tone === "danger" && "text-[#b42318]",
                tone === "muted" && "text-[#b3c4cc]",
              )}
              aria-hidden
            >
              {spent ? (
                <RotateCcw className="size-4" strokeWidth={2.2} />
              ) : current ? (
                passed ? (
                  <CheckCircle2 className="size-4" strokeWidth={2.2} />
                ) : (
                  <XCircle className="size-4" strokeWidth={2.2} />
                )
              ) : (
                <CircleDashed className="size-4" strokeWidth={2.2} />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold text-[#243640]">{heading}</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-[#5f7280]">{body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------------------------------------------------
   The self-correction explainer — the point of this screen
   -------------------------------------------------------------------------- */
function SelfCorrection({
  attempt,
  maxAttempts,
  passed,
}: {
  attempt: number;
  maxAttempts: number;
  passed: boolean;
}) {
  const corrected = attempt > 1;
  const exhausted = attempt >= maxAttempts && !passed;

  const heading = exhausted
    ? "The correction budget is spent"
    : corrected
      ? passed
        ? "The agent corrected itself"
        : "The agent is correcting itself"
      : "No correction was needed";

  return (
    <Card variant="glass" padded={false} className="animate-fade-up p-6 sm:p-7">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-8">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-[13px] text-white",
                exhausted
                  ? "bg-[#b54708] shadow-[0_8px_18px_rgba(181,71,8,0.26)]"
                  : "gradient-cta shadow-[0_8px_18px_rgba(46,96,120,0.26)]",
              )}
              aria-hidden
            >
              <RotateCcw className="size-[18px]" strokeWidth={2.2} />
            </span>
            <div className="min-w-0">
              <p className={MICRO}>Self-correction</p>
              <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
                {heading}
              </h2>
            </div>
          </div>

          <div className="mt-5 space-y-3 text-[13px] leading-relaxed text-[#5f7280]">
            {corrected ? (
              <p>
                The agent validated its own output, found it wrong, and rebuilt the
                purchase order itself — no person intervened.{" "}
                {passed
                  ? `Attempt ${attempt} is the document that finally agreed with the quote snapshot.`
                  : `Attempt ${attempt} still disagrees with the quote snapshot.`}
              </p>
            ) : (
              <p>
                The first document the agent generated already agreed with the quote
                snapshot, so the correction loop was never entered. The budget below
                was available and went unused.
              </p>
            )}

            <p>
              <Mono>validate_po</Mono> does not only move forwards. On a failure it
              returns to <Mono>generate_po</Mono> and the document is built again — a
              loop bounded by the setting{" "}
              <Mono>AGENT_MAX_SELF_CORRECTION_ATTEMPTS</Mono>, which is{" "}
              <span className="font-semibold text-[#243640]">{maxAttempts}</span> for
              this run.
            </p>
          </div>

          <div className="glass-flat mt-5 flex flex-wrap items-center gap-2 rounded-[16px] px-3.5 py-3">
            <Mono>generate_po</Mono>
            <ArrowRight className="size-3.5 text-[#a3b6c0]" aria-hidden />
            <Mono>validate_po</Mono>
            <ArrowRight className="size-3.5 text-[#a3b6c0]" aria-hidden />
            <Mono>route_approval</Mono>
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[#7e8c94]">
              <RotateCcw className="size-3.5" aria-hidden />
              on failure, back to generate_po
            </span>
          </div>

          {exhausted && (
            <Alert
              tone="warning"
              title="Escalated to a human"
              icon={<UserRoundCheck className="size-4" />}
              className="mt-4"
            >
              All {maxAttempts} attempts were used and the document still did not
              agree with the quote it came from. Rather than pushing a wrong purchase
              order through the approval gate, the run stopped and flagged itself for
              a person. Nothing has been committed.
            </Alert>
          )}
        </div>

        <div className="min-w-0">
          <p className={cn(MICRO, "mb-2.5")}>Attempt budget</p>
          <AttemptLadder attempt={attempt} maxAttempts={maxAttempts} passed={passed} />
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------------------
   Page
   -------------------------------------------------------------------------- */
export default function ValidationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["workflow", id, "validation"],
    queryFn: () => api.getValidation(id),
    // A 404 here means "not validated yet" — retrying cannot change that.
    retry: (count, err) =>
      err instanceof ApiError && (err.isNotFound || err.isForbidden)
        ? false
        : count < 2,
  });

  // The run itself, for the two things a bare 404 cannot say: whether this
  // workflow is visible at all, and whether it is the kind of run that ever
  // validates. A reimbursement never reaches validate_po — its template has no
  // such node — so "not yet" would be a lie there. Shares the execution
  // screen's cache key, so it is usually already resolved.
  const workflowQuery = useQuery({
    queryKey: ["workflow", id],
    queryFn: () => api.getWorkflow(id),
    retry: false,
  });

  const apiError = error instanceof ApiError ? error : null;
  const workflowError =
    workflowQuery.error instanceof ApiError ? workflowQuery.error : null;
  const workflow = workflowQuery.data;

  const notFound = Boolean(apiError?.isNotFound);
  // Waiting on the run before choosing an explanation, so the wrong one never
  // flashes on screen first.
  const explaining = notFound && workflowQuery.isPending;
  const runMissing = notFound && Boolean(workflowError?.isNotFound);
  const isReimbursement = workflow?.workflow_type === "reimbursement";

  const checks = data?.checks ?? [];
  const failed = checks.filter((check) => verdictOf(check) === "failed");
  const warnings = checks.filter((check) => verdictOf(check) === "warning");
  const passedCount = checks.length - failed.length - warnings.length;

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link
            href={`/workflows/${id}`}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[#5f7280] transition-colors duration-200 hover:text-[#447f98]"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {workflow?.title ?? "Back to execution"}
          </Link>
        }
        title="Validation"
        description="The deterministic checks the agent runs against its own purchase order, comparing it with the quote snapshot it selected — not with the live catalog."
      />

      <WorkflowNav workflowId={id} />

      <div className="mt-6 space-y-5">
        {isPending || explaining ? (
          <>
            <Card className="p-6">
              <LoadingBlock rows={1} />
            </Card>
            <Card className="p-6">
              <LoadingBlock rows={4} />
            </Card>
          </>
        ) : runMissing ? (
          <EmptyState
            icon={<Lock className="size-6" />}
            title="This workflow is not available"
            description="It does not exist, or it belongs to someone else. Employees see their own runs; administrators see every run in the organisation."
            action={
              <Link href="/workflows" className={PILL_LINK}>
                <ArrowLeft className="size-3.5" aria-hidden />
                All workflows
              </Link>
            }
          />
        ) : notFound ? (
          <EmptyState
            icon={<FileSearch className="size-6" />}
            title={
              isReimbursement
                ? "A reimbursement claim is not validated here"
                : "Not validated yet"
            }
            description={
              isReimbursement
                ? "This run is a reimbursement, not a procurement. Nothing is ordered from a supplier, so there is no purchase order to check against a quote — the claim is tested line by line against the expense policy at policy_check instead, and that step writes no validation report. The execution screen shows what the policy decided."
                : "No validation report exists for this workflow. The agent only validates once it has generated a purchase order, so this page fills in when the run reaches validate_po."
            }
            action={
              <Link href={`/workflows/${id}`} className={PILL_LINK}>
                <ArrowLeft className="size-3.5" aria-hidden />
                Back to execution
              </Link>
            }
          />
        ) : apiError?.isForbidden ? (
          <EmptyState
            icon={<Lock className="size-6" />}
            title="Buyer workflows are closed to vendor accounts"
            description="You are signed in as a supplier. Vendor accounts see their own purchase orders and their own catalog — never the buyer-side run that produced them."
          />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : !data ? null : (
          <>
            {/* ---- Verdict banner: screen 6a pass / 6b fail ---------------- */}
            <section
              className={cn(
                "animate-fade-up flex flex-wrap items-start gap-5 rounded-[28px] border p-6 sm:p-7",
                data.passed
                  ? "border-[#a6f4c5] bg-[#ecfdf3]"
                  : "border-[#fecdca] bg-[#fef3f2]",
              )}
            >
              <span
                className={cn(
                  "grid size-12 shrink-0 place-items-center rounded-[18px] text-white",
                  data.passed
                    ? "bg-[#17b26a] shadow-[0_12px_24px_rgba(7,148,85,0.28)]"
                    : "bg-[#b42318] shadow-[0_12px_24px_rgba(180,35,24,0.28)]",
                )}
                aria-hidden
              >
                {data.passed ? (
                  <ShieldCheck className="size-6" strokeWidth={2.1} />
                ) : (
                  <ShieldAlert className="size-6" strokeWidth={2.1} />
                )}
              </span>

              {/* `basis-64` and not a bare `flex-1`: with a zero flex-basis the
                  wrap never triggers, and on a 390px screen the headline would be
                  squeezed into the ~90px left over beside the meta column. */}
              <div className="min-w-0 flex-1 basis-64">
                <p className={MICRO}>Validation result</p>
                <h2
                  className={cn(
                    "mt-1 text-[22px] font-bold leading-tight tracking-[-0.025em]",
                    data.passed ? "text-[#067647]" : "text-[#b42318]",
                  )}
                >
                  {/* A failed report with no individually failed check is
                      possible — a warning-only report the graph rejected — and
                      "0 of 5 checks failed" would read as nonsense. */}
                  {data.passed
                    ? checks.length === 0
                      ? "Validation passed"
                      : `All ${checks.length} checks passed`
                    : failed.length > 0
                      ? `${failed.length} of ${checks.length} checks failed`
                      : "Validation failed"}
                </h2>
                <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-[#4a5c66]">
                  {data.passed
                    ? "Every line, total, supplier and term on the purchase order matches the quote the agent selected. The document went on to the approval gate, where a person decides."
                    : "The purchase order disagreed with the quote snapshot it was generated from. Each failure below shows what the agent expected and what the document actually said."}
                  {warnings.length > 0 &&
                    ` ${warnings.length} ${
                      warnings.length === 1 ? "check" : "checks"
                    } returned a warning rather than a verdict — usually a value the request never specified.`}
                </p>

                {failed.length > 0 && (
                  <ul className="mt-3.5 flex flex-wrap gap-1.5">
                    {failed.map((check, index) => (
                      <li
                        key={`${titleOf(check)}-${index}`}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#fecdca] bg-white/70 px-2.5 py-1 text-[11.5px] font-semibold text-[#b42318]"
                      >
                        <XCircle className="size-3" aria-hidden />
                        {titleOf(check)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                <StatusPill
                  dot={false}
                  tone={data.attempt > 1 ? "warning" : "neutral"}
                  label={`Attempt ${data.attempt} of ${data.max_attempts}`}
                />
                <p className="tnum text-[12px] text-[#5f7280]">
                  {dateTime(data.validated_at)}
                </p>
                <p className="text-[11.5px] text-[#a3b6c0]">
                  {relativeTime(data.validated_at)}
                </p>
              </div>
            </section>

            {/* ---- Why this screen exists --------------------------------- */}
            <SelfCorrection
              attempt={data.attempt}
              maxAttempts={data.max_attempts}
              passed={data.passed}
            />

            {/* ---- The checks, and what produced them --------------------- */}
            <div className="grid gap-5 lg:grid-cols-3">
              <Panel
                title="Checks"
                description="Deterministic Python. No model is consulted, so a failure here is reproducible."
                icon={<ClipboardList className="size-[18px]" />}
                bodyClassName="p-0"
                className="animate-fade-up lg:col-span-2"
                actions={
                  checks.length > 0 ? (
                    <span className="tnum text-[12px] font-semibold text-[#5f7280]">
                      {passedCount}/{checks.length} passed
                    </span>
                  ) : undefined
                }
              >
                {checks.length === 0 ? (
                  <div className="p-6">
                    <EmptyState
                      icon={<ClipboardList className="size-6" />}
                      title="No checks were recorded"
                      description="The report exists but carries no individual checks. That happens when a workflow type registers no validators — the verdict above is still the one the graph acted on."
                    />
                  </div>
                ) : (
                  <ul className="divide-y divide-[#eef4f7]">
                    {checks.map((check, index) => (
                      <CheckRow key={`${titleOf(check)}-${index}`} check={check} />
                    ))}
                  </ul>
                )}
              </Panel>

              <aside className="animate-fade-up space-y-5">
                <Panel title="This report" description="The latest validation pass.">
                  <dl className="divide-y divide-[#eef4f7]">
                    <div className="flex items-center justify-between gap-4 py-2">
                      <dt className="text-[12.5px] text-[#7e8c94]">Verdict</dt>
                      <dd>
                        <StatusPill
                          size="sm"
                          tone={data.passed ? "positive" : "danger"}
                          label={data.passed ? "Passed" : "Failed"}
                        />
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4 py-2">
                      <dt className="text-[12.5px] text-[#7e8c94]">Attempt</dt>
                      <dd className="tnum text-[13px] font-semibold text-[#243640]">
                        {data.attempt} of {data.max_attempts}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4 py-2">
                      <dt className="text-[12.5px] text-[#7e8c94]">Checks</dt>
                      <dd className="tnum text-right text-[13px] font-semibold text-[#243640]">
                        {passedCount} passed · {failed.length} failed
                        {warnings.length > 0 ? ` · ${warnings.length} warned` : ""}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4 py-2">
                      <dt className="text-[12.5px] text-[#7e8c94]">Validated</dt>
                      <dd className="tnum text-right text-[13px] font-semibold text-[#243640]">
                        {dateTime(data.validated_at)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-4 py-2">
                      <dt className="text-[12.5px] text-[#7e8c94]">Workflow</dt>
                      <dd className="flex items-center gap-1">
                        <Mono>{data.workflow_id.slice(0, 8)}</Mono>
                        <CopyButton value={data.workflow_id} label="Copy" />
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-4 py-2">
                      <dt className="text-[12.5px] text-[#7e8c94]">Purchase order</dt>
                      <dd className="flex items-center gap-1">
                        {data.purchase_order_id ? (
                          <>
                            <Mono>{data.purchase_order_id.slice(0, 8)}</Mono>
                            <CopyButton value={data.purchase_order_id} label="Copy" />
                          </>
                        ) : (
                          <span className="text-[12.5px] text-[#a3b6c0]">
                            Not linked
                          </span>
                        )}
                      </dd>
                    </div>
                  </dl>

                  {data.purchase_order_id && (
                    <Link
                      href={`/workflows/${id}/purchase-order`}
                      className={cn(PILL_LINK, "mt-4")}
                    >
                      Open the purchase order
                      <ArrowRight className="size-3.5" aria-hidden />
                    </Link>
                  )}
                </Panel>

                <Panel title="What a check compares">
                  <p className="text-[12.5px] leading-relaxed text-[#5f7280]">
                    Every check reads the quote snapshot taken at selection time, not
                    the catalog as it stands today. If a vendor changes a price
                    afterwards, the purchase order is still judged against the price
                    that was actually quoted — which is what makes supplier
                    consistency provable rather than merely plausible.
                  </p>
                </Panel>
              </aside>
            </div>
          </>
        )}
      </div>
    </>
  );
}
