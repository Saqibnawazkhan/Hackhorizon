"use client";

/**
 * Screens 12a / 8b — the decision.
 *
 * The left column is everything needed to decide: the sentence the employee
 * actually typed, the order the agent built from it, and how that order sits
 * against the budget. The right column is the act itself, and it commits real
 * spend — so both buttons pass through a confirmation that restates the amount
 * and the supplier before the call leaves the browser.
 *
 * The decision endpoint is idempotent. It answers with `resumed`, which is
 * false when the decision was already on record: the graph resumes exactly
 * once, no matter how many times the button is pressed. That is the guarantee
 * working, not a failure, and it is reported as neutral information.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Gavel,
  Landmark,
  ListTree,
  Route,
  Scale,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { use, useState, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Button,
  Card,
  CopyButton,
  Divider,
  ErrorState,
  Field,
  KeyValue,
  Modal,
  Mono,
  Panel,
  ProgressBar,
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
import { ApiError, api } from "@/lib/api";
import {
  WORKFLOW_STATUS_LABEL,
  WORKFLOW_STATUS_TONE,
  asNumber,
  dateTime,
  money,
  number,
  percent,
  relativeTime,
  type Tone,
} from "@/lib/format";
import type { ApprovalDecision, POLineItem } from "@/lib/types";

/* format.ts carries no vocabulary for an approval decision, so the queue's
   copy lives here rather than being re-invented per component. */
const DECISION_LABEL: Record<ApprovalDecision, string> = {
  pending: "Awaiting your decision",
  approved: "Approved",
  rejected: "Rejected",
};

/** `ApprovalDecisionRequest.comment` is `Field(None, max_length=1000)`. */
const COMMENT_LIMIT = 1000;

const DECISION_TONE: Record<ApprovalDecision, Tone> = {
  pending: "warning",
  approved: "positive",
  rejected: "danger",
};

/* --------------------------------------------------------------------------
   Local pieces
   -------------------------------------------------------------------------- */

function CalmPanel({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="animate-fade-up mx-auto max-w-2xl text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-[18px] bg-[#e9f3f8] text-[#38677b]">
        {icon}
      </div>
      <h2 className="mt-4 text-[16px] font-semibold tracking-[-0.02em] text-[#243640]">
        {title}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[#5f7280]">
        {children}
      </p>
      <Link
        href="/admin/approvals"
        className="mt-5 inline-flex h-10 items-center gap-2 rounded-[14px] border border-white/80 bg-white/75 px-4 text-[13px] font-semibold text-[#243640] shadow-[0_8px_22px_rgba(46,96,120,0.10)] transition-colors duration-200 hover:bg-white/95"
      >
        <ArrowLeft className="size-4" />
        Back to the queue
      </Link>
    </Card>
  );
}

function CrossLink({
  href,
  title,
  description,
  icon,
}: {
  href: string;
  title: string;
  description: string;
  icon: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="glass-flat group flex items-start gap-3.5 rounded-[20px] p-4 transition-all duration-200 hover:bg-white/90 hover:shadow-[0_12px_28px_rgba(46,96,120,0.14)]"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-[#e9f3f8] text-[#38677b]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-semibold text-[#243640]">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-[#7e8c94]">
          {description}
        </span>
      </span>
      <ArrowRight className="mt-1 size-4 shrink-0 text-[#a9bac3] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-[#447f98]" />
    </Link>
  );
}

/* --------------------------------------------------------------------------
   Page
   -------------------------------------------------------------------------- */
export default function ApprovalDecisionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [comment, setComment] = useState("");
  const [confirming, setConfirming] = useState<"approved" | "rejected" | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["approval", id],
    queryFn: () => api.getApproval(id),
  });

  const workflowId = data?.workflow_id ?? null;

  /* The approval payload names no vendor. The selected quote does, and it is
     the same record the PO was generated from — so the supplier is read from
     the comparison rather than guessed. A run whose comparison is gone simply
     shows no name; nothing here fabricates one. */
  const comparison = useQuery({
    queryKey: ["comparison", workflowId],
    queryFn: async () => (workflowId ? api.getComparison(workflowId) : []),
    enabled: workflowId !== null,
    retry: false,
  });
  const vendorName =
    comparison.data?.find((quote) => quote.status === "selected")?.vendor_name ?? null;
  /* Until the comparison answers, "Not recorded" is a claim we cannot make —
     the supplier may well be recorded and simply not read back yet. The three
     silences are different facts and are worded as three different facts: the
     read is still in flight; the endpoint answered 404 because this run never
     scored quotes (a reimbursement does not); or the read itself failed. */
  const supplierPending = vendorName === null && comparison.isPending;
  const comparisonMissing =
    comparison.error instanceof ApiError && comparison.error.isNotFound;
  const supplierLabel =
    vendorName ??
    (supplierPending
      ? "Reading the comparison…"
      : comparisonMissing
        ? "No supplier comparison on this run"
        : comparison.isError
          ? "Comparison could not be read"
          : "Not recorded");

  const decide = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      api.decideApproval(id, decision, comment.trim() ? comment.trim() : undefined),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["approval", id] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      void queryClient.invalidateQueries({
        queryKey: ["workflow", result.approval.workflow_id],
      });
      setConfirming(null);

      if (!result.resumed) {
        toast(
          "This decision was already on record, so the graph was not resumed a second time. The endpoint is idempotent — nothing ran twice.",
          "neutral",
        );
        return;
      }
      if (result.approval.decision === "approved") {
        toast("Approved. The graph has resumed from the interrupt and the order is committed.");
      } else {
        toast("Rejected. The graph has resumed and no order will be placed.", "neutral");
      }
    },
    onError: (mutationError: unknown) => {
      /* The API's 403 reads "this endpoint requires role admin; you are
         employee" — a raw role enum, which is not something to put in front of
         a reader. Reading the queue is wider than clearing it, so an employee
         can legitimately reach this screen and land here. */
      if (mutationError instanceof ApiError && mutationError.isForbidden) {
        toast(
          "Only an administrator can decide an approval. Nothing was recorded, and the run is still held at the gate.",
          "danger",
        );
        return;
      }
      toast(
        mutationError instanceof Error
          ? mutationError.message
          : "The decision could not be recorded.",
        "danger",
      );
    },
  });

  const workflow = data?.workflow ?? null;
  const po = data?.purchase_order ?? null;
  const currency = po?.currency ?? workflow?.currency ?? undefined;

  const orderTotal = asNumber(po?.total_amount);
  const budget = asNumber(workflow?.budget);
  const delta = orderTotal !== null && budget !== null ? orderTotal - budget : null;
  const over = delta !== null && delta > 0;
  const usedFraction = orderTotal !== null && budget && budget > 0 ? orderTotal / budget : null;

  const lineItems: POLineItem[] = po?.line_items ?? [];
  const linesTotal = lineItems.reduce(
    (sum, line) => sum + (asNumber(line.line_total) ?? 0),
    0,
  );
  const linesDiffer =
    orderTotal !== null && lineItems.length > 0 && Math.abs(orderTotal - linesTotal) > 0.5;

  const decided = data !== undefined && data.decision !== "pending";
  const forbidden = error instanceof ApiError && error.isForbidden;
  const notFound = error instanceof ApiError && error.isNotFound;

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link
            href="/admin/approvals"
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#7e8c94] transition-colors duration-200 hover:text-[#447f98]"
          >
            <ArrowLeft className="size-3.5" />
            Approval queue
          </Link>
        }
        title={workflow?.title ?? "Approval"}
        description={
          /* A decided approval is not "held at the gate" — saying so would
             contradict the panel on the right, which correctly reports that
             the graph has already resumed. */
          !data
            ? "The human gate. Nothing is committed until an administrator decides."
            : !decided
              ? `Requested ${relativeTime(data.requested_at)} · the run is held at the approval gate until you decide.`
              : data.decided_at
                ? `Requested ${relativeTime(data.requested_at)} · decided ${relativeTime(data.decided_at)}. The graph has already resumed.`
                : `Requested ${relativeTime(data.requested_at)} · this decision is already on record and the graph has resumed.`
        }
        actions={
          data ? (
            <StatusPill
              tone={DECISION_TONE[data.decision]}
              label={DECISION_LABEL[data.decision]}
            />
          ) : undefined
        }
      />

      {isLoading ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="space-y-5">
            <Skeleton className="h-[220px] rounded-[28px]" />
            <Skeleton className="h-[160px] rounded-[28px]" />
            <Skeleton className="h-[320px] rounded-[28px]" />
          </div>
          <Skeleton className="h-[420px] rounded-[28px]" />
        </div>
      ) : forbidden ? (
        <CalmPanel icon={<ShieldCheck className="size-6" />} title="Not visible to this account">
          The API refuses approvals to supplier accounts: reading the buyer&rsquo;s
          gate would expose what every other supplier was quoted. Deciding is
          narrower still — that is reserved for administrators, and the agent
          itself is never given it.
        </CalmPanel>
      ) : notFound ? (
        <CalmPanel icon={<Gavel className="size-6" />} title="This approval is not readable from here">
          No approval with this identifier is visible to your account. The link
          may belong to another organisation — or, if you raised the request
          rather than administer it, to someone else&rsquo;s.
        </CalmPanel>
      ) : error || !data ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] lg:items-start">
          {/* ================================================================
              LEFT — the evidence
              ================================================================ */}
          <div className="min-w-0 space-y-5">
            <Card className="animate-fade-up">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                    Originating request
                  </p>
                  <h2 className="mt-1 text-[18px] font-bold leading-snug tracking-[-0.02em] text-[#243640]">
                    {workflow?.title ?? "Request unavailable"}
                  </h2>
                </div>
                {workflow && (
                  <StatusPill
                    tone={WORKFLOW_STATUS_TONE[workflow.status]}
                    label={WORKFLOW_STATUS_LABEL[workflow.status]}
                  />
                )}
              </div>

              {workflow ? (
                <figure className="mt-4 rounded-[20px] border-l-[3px] border-[#447f98] bg-white/65 px-5 py-4">
                  <blockquote className="text-[14px] italic leading-relaxed text-[#243640]">
                    &ldquo;{workflow.request_text}&rdquo;
                  </blockquote>
                  <figcaption className="mt-2.5 text-[11.5px] leading-relaxed text-[#7e8c94]">
                    Quoted verbatim. The workflow type, the items and the budget
                    below were all inferred from this sentence — no form, no
                    client-side hint.
                  </figcaption>
                </figure>
              ) : (
                <Alert tone="neutral" className="mt-4">
                  The originating workflow is no longer readable, so the request
                  text cannot be shown.
                </Alert>
              )}

              <dl className="mt-4 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                <KeyValue
                  label="Budget on the request"
                  value={<span className="tnum">{money(workflow?.budget, currency)}</span>}
                  className="border-b border-[#eef4f7]"
                />
                <KeyValue
                  label="Requested"
                  value={
                    <span title={dateTime(data.requested_at)}>
                      {relativeTime(data.requested_at)}
                    </span>
                  }
                  className="border-b border-[#eef4f7]"
                />
                <KeyValue
                  label="Selected supplier"
                  value={
                    vendorName ?? (
                      <span className="font-normal text-[#7e8c94]">{supplierLabel}</span>
                    )
                  }
                  className="border-b border-[#eef4f7]"
                />
                <KeyValue
                  label="Approval id"
                  value={
                    <span className="inline-flex items-center gap-1">
                      <Mono>{data.id.slice(0, 8)}</Mono>
                      <CopyButton value={data.id} label="Copy" />
                    </span>
                  }
                  className="border-b border-[#eef4f7]"
                />
              </dl>
            </Card>

            {/* -- Budget fit ------------------------------------------------ */}
            <Card className="animate-fade-up">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-white/70 text-[#447f98] shadow-[0_4px_12px_rgba(46,96,120,0.10)]">
                    <Scale className="size-4" />
                  </span>
                  <div>
                    <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
                      Budget fit
                    </h2>
                    <p className="mt-0.5 text-[12.5px] text-[#7e8c94]">
                      Order total measured against the budget on the request.
                    </p>
                  </div>
                </div>
                {usedFraction !== null && (
                  <p
                    className={cn(
                      "text-[13px] font-semibold tnum",
                      over ? "text-[#b42318]" : "text-[#067647]",
                    )}
                  >
                    {percent(usedFraction)} of budget
                  </p>
                )}
              </div>

              {budget === null || budget <= 0 || orderTotal === null ? (
                <Alert tone="neutral" className="mt-4">
                  {orderTotal === null
                    ? "No purchase order is attached to this approval, so there is no total to measure."
                    : "No budget was recorded on this request, so the total cannot be checked against one."}
                </Alert>
              ) : (
                <>
                  <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                        Order total
                      </p>
                      <p className="mt-1 text-[24px] font-bold leading-none tracking-[-0.03em] text-[#243640] tnum">
                        {money(orderTotal, currency)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                        Budget
                      </p>
                      <p className="mt-1 text-[17px] font-semibold leading-none text-[#5f7280] tnum">
                        {money(budget, currency)}
                      </p>
                    </div>
                  </div>

                  <ProgressBar
                    className="mt-4"
                    height={10}
                    value={usedFraction !== null ? usedFraction * 100 : 0}
                    tone={over ? "danger" : "positive"}
                  />

                  <p
                    className={cn(
                      "mt-3 text-[13px] font-semibold",
                      over ? "text-[#b42318]" : "text-[#067647]",
                    )}
                  >
                    {over
                      ? `${money(Math.abs(delta ?? 0), currency)} over the recorded budget`
                      : `${money(Math.abs(delta ?? 0), currency)} of headroom remains`}
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-[#7e8c94]">
                    {over
                      ? "The agent could not bring the order inside the budget within its self-correction limit. Approving accepts the overrun."
                      : "The budget filter excluded every quote above this line before scoring began."}
                  </p>
                </>
              )}
            </Card>

            {/* -- The order ------------------------------------------------- */}
            {po ? (
              <Panel
                className="animate-fade-up"
                icon={<FileText className="size-4" />}
                title="Purchase order"
                description="Generated by the agent, then validated before the run stopped here."
                actions={
                  <span className="inline-flex items-center gap-1">
                    <Mono>{po.po_number}</Mono>
                    <CopyButton value={po.po_number} label="Copy" />
                  </span>
                }
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="glass-flat rounded-[18px] px-4 py-3.5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                      Total
                    </p>
                    <p className="mt-1.5 text-[17px] font-bold leading-none tracking-[-0.02em] text-[#243640] tnum">
                      {money(po.total_amount, po.currency)}
                    </p>
                  </div>
                  <div className="glass-flat rounded-[18px] px-4 py-3.5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                      Delivery
                    </p>
                    <p className="mt-1.5 text-[17px] font-bold leading-none tracking-[-0.02em] text-[#243640] tnum">
                      {po.delivery_days === null ? "—" : `${number(po.delivery_days)} days`}
                    </p>
                  </div>
                  <div className="glass-flat rounded-[18px] px-4 py-3.5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                      Warranty
                    </p>
                    <p className="mt-1.5 text-[17px] font-bold leading-none tracking-[-0.02em] text-[#243640] tnum">
                      {po.warranty_months === null
                        ? "—"
                        : `${number(po.warranty_months)} months`}
                    </p>
                  </div>
                </div>

                {lineItems.length === 0 ? (
                  <Alert tone="neutral" className="mt-5">
                    This order carries no line items.
                  </Alert>
                ) : (
                  <div className="mt-5">
                    <Table minWidth={620}>
                      <thead>
                        <tr>
                          <Th className="w-10">#</Th>
                          <Th>Description</Th>
                          <Th align="right">Qty</Th>
                          <Th align="right">Unit price</Th>
                          <Th align="right">Line total</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {lineItems.map((line) => (
                          <Tr key={line.line_number}>
                            <Td className="text-[12px] text-[#7e8c94] tnum">
                              {line.line_number}
                            </Td>
                            <Td className="font-medium">{line.description}</Td>
                            <Td align="right">{number(line.quantity)}</Td>
                            <Td align="right">{money(line.unit_price, po.currency)}</Td>
                            <Td align="right" className="font-semibold">
                              {money(line.line_total, po.currency)}
                            </Td>
                          </Tr>
                        ))}
                        {/* The Line total column sums to the SUBTOTAL. Putting
                            the PO's total straight under it invites the reader
                            to add the column up and find it wrong, so when the
                            two differ the subtotal is stated as its own row. */}
                        {linesDiffer && (
                          <tr>
                            <Td colSpan={4} className="border-b-0 pt-4 text-right">
                              <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                                Lines subtotal
                              </span>
                            </Td>
                            <Td
                              align="right"
                              className="border-b-0 pt-4 text-[13px] font-semibold text-[#5f7280]"
                            >
                              {money(linesTotal, po.currency)}
                            </Td>
                          </tr>
                        )}
                        <tr>
                          <Td
                            colSpan={4}
                            className={cn(
                              "border-b-0 text-right",
                              linesDiffer ? "pt-1" : "pt-4",
                            )}
                          >
                            <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                              Order total
                            </span>
                          </Td>
                          <Td
                            align="right"
                            className={cn(
                              "border-b-0 text-[15px] font-bold text-[#243640]",
                              linesDiffer ? "pt-1" : "pt-4",
                            )}
                          >
                            {money(po.total_amount, po.currency)}
                          </Td>
                        </tr>
                      </tbody>
                    </Table>
                    {linesDiffer && (
                      <p className="mt-3 text-[11.5px] leading-relaxed text-[#7e8c94]">
                        {linesTotal < (orderTotal ?? 0)
                          ? "The difference between the two is the tax recorded on the purchase order."
                          : "The order total sits below the sum of its own lines — read the purchase order itself before deciding."}
                      </p>
                    )}
                  </div>
                )}
              </Panel>
            ) : (
              <Alert tone="warning" title="No purchase order is attached">
                This approval was raised without a generated order — usually an
                escalation. Read the execution trace before deciding.
              </Alert>
            )}

            {workflowId && (
              <div className="grid gap-3 sm:grid-cols-2">
                <CrossLink
                  href={`/workflows/${workflowId}`}
                  icon={<Route className="size-4" />}
                  title="Full execution trace"
                  description="Every step, tool call, retry and self-correction that produced this order."
                />
                <CrossLink
                  href={`/workflows/${workflowId}/comparison`}
                  icon={<ListTree className="size-4" />}
                  title="Scoring and comparison"
                  description="The weighted maths behind this supplier, and what was excluded before scoring."
                />
              </div>
            )}
          </div>

          {/* ================================================================
              RIGHT — the act
              ================================================================ */}
          <div className="min-w-0 lg:sticky lg:top-20">
            <Card className="animate-fade-up">
              <div className="flex items-start gap-3">
                <span className="gradient-cta grid size-10 shrink-0 place-items-center rounded-[14px] text-white shadow-[0_10px_20px_rgba(46,96,120,0.28)]">
                  <Gavel className="size-[18px]" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
                    Your decision
                  </h2>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-[#7e8c94]">
                    {decided
                      ? "Recorded. The graph has already been resumed."
                      : "This resumes the graph. Approving commits the spend."}
                  </p>
                </div>
              </div>

              <div className="gradient-hero mt-5 rounded-[20px] px-5 py-4 text-white">
                <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-white/60">
                  {decided ? "Amount decided" : "Amount to commit"}
                </p>
                <p className="mt-1.5 text-[26px] font-bold leading-none tracking-[-0.03em] tnum">
                  {money(po?.total_amount, currency)}
                </p>
                <p className="mt-2.5 text-[12.5px] text-white/70">
                  {vendorName ? `To ${vendorName}` : supplierLabel}
                  {po ? ` · ${po.po_number}` : ""}
                </p>
              </div>

              {decided ? (
                <div className="mt-5 space-y-4">
                  <div className="glass-flat rounded-[20px] p-4">
                    <StatusPill
                      tone={DECISION_TONE[data.decision]}
                      label={DECISION_LABEL[data.decision]}
                    />
                    <dl className="mt-3">
                      <KeyValue label="Decided" value={dateTime(data.decided_at)} />
                      <KeyValue
                        label="Administrator id"
                        value={
                          data.decided_by ? (
                            <span className="inline-flex items-center gap-1">
                              <Mono>{data.decided_by.slice(0, 8)}</Mono>
                              <CopyButton value={data.decided_by} label="Copy" />
                            </span>
                          ) : (
                            "—"
                          )
                        }
                      />
                    </dl>
                    <div className="mt-2 border-t border-[#eef4f7] pt-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                        Comment
                      </p>
                      <p className="mt-1 text-[13px] leading-relaxed text-[#243640]">
                        {data.comment?.trim() ? data.comment : "None recorded."}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <Button variant="success" full disabled icon={<Check className="size-4" />}>
                      Approve
                    </Button>
                    <Button variant="danger" full disabled icon={<X className="size-4" />}>
                      Reject
                    </Button>
                    <p className="text-center text-[11.5px] text-[#7e8c94]">
                      Controls are disabled: an approval is decided once.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mt-5 space-y-4">
                  <Field
                    label="Comment"
                    htmlFor="approval-comment"
                    hint={
                      comment.length > COMMENT_LIMIT - 100
                        ? `${number(COMMENT_LIMIT - comment.length)} characters left — the API stores at most ${number(COMMENT_LIMIT)}.`
                        : "Optional. Stored with the decision and handed back into the graph when it resumes."
                    }
                  >
                    <Textarea
                      id="approval-comment"
                      value={comment}
                      onChange={(event) =>
                        setComment(event.target.value.slice(0, COMMENT_LIMIT))
                      }
                      maxLength={COMMENT_LIMIT}
                      placeholder="Why you are approving or rejecting this order…"
                      className="min-h-[92px]"
                      disabled={decide.isPending}
                    />
                  </Field>

                  <div className="space-y-2.5">
                    <Button
                      variant="success"
                      full
                      icon={<Check className="size-4" />}
                      disabled={decide.isPending}
                      onClick={() => setConfirming("approved")}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="danger"
                      full
                      icon={<X className="size-4" />}
                      disabled={decide.isPending}
                      onClick={() => setConfirming("rejected")}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              )}

              <Divider className="my-5" />

              <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-[#7e8c94]">
                <ShieldCheck className="mt-px size-3.5 shrink-0 text-[#447f98]" />
                The agent never auto-approves. This decision is recorded against
                the signed-in administrator, and only then is the graph resumed
                from its interrupt.
              </p>
            </Card>
          </div>
        </div>
      )}

      {/* ==================================================================
          Confirmation — the last thing between a click and committed spend
          ================================================================== */}
      <Modal
        open={confirming !== null}
        onClose={() => {
          if (!decide.isPending) setConfirming(null);
        }}
        title={
          confirming === "rejected" ? "Reject this purchase order?" : "Approve this purchase order?"
        }
        description={
          confirming === "rejected"
            ? "The graph resumes on the rejected branch. No order is placed."
            : "The graph resumes on the approved branch and this spend is committed."
        }
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setConfirming(null)}
              disabled={decide.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={confirming === "rejected" ? "danger" : "success"}
              loading={decide.isPending}
              icon={
                confirming === "rejected" ? <X className="size-4" /> : <Check className="size-4" />
              }
              onClick={() => {
                if (confirming) decide.mutate(confirming);
              }}
            >
              {confirming === "rejected" ? "Reject and resume" : "Approve and resume"}
            </Button>
          </>
        }
      >
        <div className="glass-flat rounded-[20px] p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-white/80 text-[#447f98]">
              <Landmark className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                {confirming === "rejected" ? "Amount refused" : "Amount committed"}
              </p>
              <p className="mt-1 text-[22px] font-bold leading-none tracking-[-0.03em] text-[#243640] tnum">
                {money(po?.total_amount, currency)}
              </p>
            </div>
          </div>
          <dl className="mt-3 border-t border-[#eef4f7] pt-1">
            <KeyValue label="Supplier" value={supplierLabel} />
            <KeyValue
              label="Purchase order"
              value={po ? <Mono>{po.po_number}</Mono> : "None attached"}
            />
            <KeyValue
              label="Budget on the request"
              value={<span className="tnum">{money(workflow?.budget, currency)}</span>}
            />
          </dl>
        </div>

        {over && confirming === "approved" && (
          <Alert tone="warning" className="mt-4" title="This total is over budget">
            {money(Math.abs(delta ?? 0), currency)} above the budget recorded on
            the request. Approving accepts the overrun.
          </Alert>
        )}

        {comment.trim() && (
          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
              Your comment
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-[#243640]">{comment.trim()}</p>
          </div>
        )}

        <p className="mt-4 pb-2 text-[11.5px] leading-relaxed text-[#7e8c94]">
          Recorded against your account, then the run resumes. Pressing this
          twice is safe: the decision is written once and the graph resumes
          once.
        </p>
      </Modal>
    </>
  );
}
