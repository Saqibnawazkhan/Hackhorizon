"use client";

/**
 * Purchase order — design screen 7a.
 *
 * A purchase order is a document, not a record view: it gets printed, filed and
 * sent to a supplier. So the page renders one — a numbered header, terms, a
 * line-item table and a totals block — and everything that is console chrome
 * rather than document (the nav, the buttons, the side rail) carries `no-print`
 * so paper gets only the order.
 *
 * `pdf_url` is a Supabase signed link minted per request. It is legitimately
 * null when storage is unconfigured or the link has expired; the order itself
 * is unaffected, and this page is the record either way.
 *
 * The one thing on this page that is not the document is the close-out, and it
 * carries a distinction worth stating twice: `delivery_status` is the
 * SUPPLIER's account of this order, moved by the vendor in their own portal.
 * The close-out is the BUYER's, recorded against the signed-in user. Until it
 * existed, every vendor reliability score rested on the supplier's own report
 * of its own performance.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BadgeCheck,
  CalendarClock,
  ClipboardCheck,
  Download,
  FileText,
  Lock,
  Megaphone,
  PackageCheck,
  Printer,
  ReceiptText,
  RotateCcw,
  ShieldCheck,
  Truck,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { use, useState, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Mono,
  Panel,
  StatusPill,
  TONE_PILL,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
  cn,
  useToast,
} from "@/components/ui";
import { WorkflowNav } from "@/components/workflow/WorkflowNav";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  DELIVERY_STATUS_LABEL,
  DELIVERY_STATUS_TONE,
  dateOnly,
  dateTime,
  humanise,
  money,
  number as formatNumber,
  type Tone,
} from "@/lib/format";
import type { POCloseResult, POClosureOutcome } from "@/lib/types";

const MICRO = "text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]";

/** The primary button's look on an anchor — a download is a link, not a form. */
const LINK_BUTTON =
  "gradient-cta inline-flex h-9 items-center justify-center gap-2 rounded-[12px] px-3.5 " +
  "text-[12.5px] font-semibold tracking-[-0.01em] text-white " +
  "shadow-[0_14px_28px_rgba(46,96,120,0.32)] transition-all duration-200 " +
  "hover:brightness-[1.04] hover:shadow-[0_18px_34px_rgba(46,96,120,0.40)] active:translate-y-px";

/** The quiet pill link an empty state offers instead of a dead end. */
const PILL_LINK =
  "inline-flex items-center gap-1.5 rounded-[12px] bg-[#e9f3f8] px-3 py-2 " +
  "text-[12.5px] font-semibold text-[#38677b] transition-colors duration-200 hover:bg-[#d6ebf3]";

/* --------------------------------------------------------------------------
   Close-out vocabulary — the buyer's three verdicts
   -------------------------------------------------------------------------- */
const CLOSURE_LABEL: Record<POClosureOutcome, string> = {
  completed: "Completed",
  completed_with_issues: "Completed with issues",
  cancelled: "Cancelled",
};

const CLOSURE_TONE: Record<POClosureOutcome, Tone> = {
  completed: "positive",
  completed_with_issues: "warning",
  cancelled: "danger",
};

const CLOSURE_OPTIONS: {
  value: POClosureOutcome;
  short: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    value: "completed",
    short: "Completed",
    hint: "Everything on the order arrived, in the quantity ordered, in an acceptable state.",
    placeholder: "Received in full and checked against the packing list.",
  },
  {
    value: "completed_with_issues",
    short: "With issues",
    hint: "It arrived, but not cleanly — short, late, damaged or substituted. The note says which.",
    placeholder: "Two units arrived damaged; the supplier agreed to replace them next week.",
  },
  {
    value: "cancelled",
    short: "Cancelled",
    hint: "The order was not fulfilled and will not be. The note says why.",
    placeholder: "Supplier could not source the units in time; the order was withdrawn.",
  },
];

/**
 * A note is what makes a bad outcome worth recording.
 *
 * The API enforces this too — `PurchaseOrderClose` refuses either of these
 * outcomes without one and answers 422 — so validating here is not a
 * duplicate rule, it is the same rule stated where the buyer can act on it.
 */
function noteRequired(outcome: POClosureOutcome): boolean {
  return outcome === "completed_with_issues" || outcome === "cancelled";
}

/**
 * The 409 body is the record talking, but it talks in database vocabulary:
 * "…already closed on 12 Mar 2026 as completed_with_issues". A stored enum is
 * not a sentence, so the three tokens are swapped for the words the rest of
 * this screen uses before the message is shown to anyone.
 *
 * Longest token first — replacing "completed" ahead of "completed_with_issues"
 * would strand the tail of it on screen.
 */
const CLOSURE_TOKENS: POClosureOutcome[] = [
  "completed_with_issues",
  "cancelled",
  "completed",
];

function readableClosureMessage(message: string): string {
  let text = message.trim();
  for (const token of CLOSURE_TOKENS) {
    text = text.split(token).join(CLOSURE_LABEL[token].toLowerCase());
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * `escalation_reason` is written by the node that raised it — "No supplier in
 * the catalog matches this request" — and carries no full stop. It gets read
 * into the middle of a paragraph here, so it needs one.
 */
function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function TermTile({
  icon,
  label,
  value,
  muted,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="glass-flat rounded-[16px] p-4">
      <div className="flex items-center gap-2 text-[#7e8c94]">
        <span aria-hidden>{icon}</span>
        <p className={MICRO}>{label}</p>
      </div>
      <p
        className={cn(
          "tnum mt-2 text-[14px] font-semibold tracking-[-0.01em]",
          muted ? "text-[#a3b6c0]" : "text-[#243640]",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function TotalRow({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-6",
        emphasis ? "pt-3" : "py-1.5",
      )}
    >
      <dt
        className={cn(
          emphasis
            ? "text-[13px] font-semibold text-[#243640]"
            : "text-[12.5px] text-[#7e8c94]",
        )}
      >
        {label}
      </dt>
      <dd
        className={cn(
          "tnum text-right",
          emphasis
            ? "text-[22px] font-bold tracking-[-0.025em] text-[#101828]"
            : "text-[13px] font-semibold text-[#243640]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * One of the two accounts of this order, labelled with whose it is.
 *
 * Rendering them as a pair is the whole point: a vendor marking something
 * delivered and a buyer confirming it arrived are different claims, and the
 * screen would be misleading if it let either stand for the other.
 */
function ClaimRow({
  who,
  source,
  value,
}: {
  who: string;
  source: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className={MICRO}>{who}</p>
        <p className="mt-0.5 text-[11.5px] leading-snug text-[#7e8c94]">{source}</p>
      </div>
      <div className="shrink-0 text-right">{value}</div>
    </div>
  );
}

/** Three verdicts, each in its own colour, stacked rather than squeezed at 390px. */
function OutcomeChoice({
  value,
  onChange,
  disabled,
}: {
  value: POClosureOutcome;
  onChange: (next: POClosureOutcome) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Close-out outcome"
      className="grid gap-2 sm:grid-cols-3"
    >
      {CLOSURE_OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-[14px] border px-3 py-2.5 text-[12.5px] font-semibold tracking-[-0.01em]",
              "transition-all duration-200 disabled:opacity-50",
              selected
                ? cn(
                    TONE_PILL[CLOSURE_TONE[option.value]],
                    "shadow-[0_6px_16px_rgba(46,96,120,0.14)]",
                  )
                : "border-white/80 bg-white/60 text-[#5f7280] hover:bg-white/90 hover:text-[#243640]",
            )}
          >
            {option.short}
          </button>
        );
      })}
    </div>
  );
}

export default function PurchaseOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["workflow", id, "purchase-order"],
    queryFn: () => api.getPurchaseOrder(id),
    // A 404 means the run has not reached generate_po — retrying cannot help.
    retry: (count, err) =>
      err instanceof ApiError && (err.isNotFound || err.isForbidden)
        ? false
        : count < 2,
  });

  // The run itself, for what a bare 404 cannot say: whether this workflow is
  // visible at all, and whether it is the kind of run that ever orders
  // anything. A reimbursement never reaches generate_po — its template renders
  // a claim summary instead — so "not yet" would be a lie there. Shares the
  // execution screen's cache key, so it is usually already resolved.
  const workflowQuery = useQuery({
    queryKey: ["workflow", id],
    queryFn: () => api.getWorkflow(id),
    retry: false,
  });

  // The supplier's name lives on the vendor, not on the order. Supplementary:
  // if it fails the document still renders in full, and says so rather than
  // printing a fragment of a UUID where a company name belongs.
  const { data: vendor, isLoading: vendorLoading } = useQuery({
    queryKey: ["vendor", data?.vendor_id],
    queryFn: () => api.getVendor(data!.vendor_id),
    enabled: Boolean(data?.vendor_id),
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
  // An escalated run is not a run that has "not got there yet" — it stopped,
  // and it will keep stopping until something changes in the catalog. Saying
  // "until then there is nothing to show" would tell the buyer to wait for
  // something that is never coming.
  const isEscalated = !isReimbursement && workflow?.status === "escalated";

  const lines = data?.line_items ?? [];
  const orderedQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);

  /* ----------------------------------------------------------------------
     The buyer's close-out
     ---------------------------------------------------------------------- */
  const [closeOpen, setCloseOpen] = useState(false);
  const [outcome, setOutcome] = useState<POClosureOutcome>("completed");
  const [note, setNote] = useState("");
  const [received, setReceived] = useState("");
  const [formError, setFormError] = useState<{
    tone: Tone;
    title: string;
    message: string;
  } | null>(null);

  /**
   * The recorded close-out lives in local state, not in the query cache.
   *
   * `GET /workflows/{id}/purchase-order` does not return the closure columns
   * yet, so there is nothing to refetch them from: the mutation's own result
   * is the only place this session can read what was recorded. On a fresh page
   * load the panel therefore offers the button again, and the API answers 409
   * with a message naming the date and the outcome — which is the record
   * talking, not a failure, so `alreadyClosed` renders it as information.
   */
  const [closeResult, setCloseResult] = useState<POCloseResult | null>(null);
  const [alreadyClosed, setAlreadyClosed] = useState<string | null>(null);

  /**
   * Whether the close-out is what moved the supplier-side status.
   *
   * A clean completion advances `delivery_status` to delivered when the vendor
   * had not got there first. Once that happens the order says "Delivered" —
   * and labelling that "set by the vendor in the portal" would attribute the
   * buyer's own claim to the supplier, which is precisely the confusion this
   * panel exists to prevent. Captured at the moment of closing, because the
   * refetched order can no longer tell the two apart.
   */
  const [closeAdvancedSupplier, setCloseAdvancedSupplier] = useState(false);

  const receivedTrimmed = received.trim();
  const receivedNumber = receivedTrimmed === "" ? null : Number(receivedTrimmed);
  const receivedInvalid =
    receivedNumber !== null &&
    (!Number.isFinite(receivedNumber) ||
      !Number.isInteger(receivedNumber) ||
      receivedNumber < 0);
  const shortfall =
    receivedNumber !== null && !receivedInvalid && receivedNumber < orderedQuantity
      ? orderedQuantity - receivedNumber
      : 0;
  const selectedOption =
    CLOSURE_OPTIONS.find((option) => option.value === outcome) ?? CLOSURE_OPTIONS[0];
  const noteMissing = noteRequired(outcome) && !note.trim();

  const closeMutation = useMutation({
    mutationFn: () =>
      api.closePurchaseOrder(id, {
        outcome,
        note: note.trim() ? note.trim() : null,
        received_quantity: receivedNumber,
      }),
    onSuccess: (result) => {
      setCloseResult(result);
      setAlreadyClosed(null);
      setCloseAdvancedSupplier(
        result.closure_outcome === "completed" &&
          data?.delivery_status !== "delivered",
      );
      setCloseOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["workflow", id] });
      void queryClient.invalidateQueries({
        queryKey: ["workflow", id, "purchase-order"],
      });
      toast(
        `${result.po_number} closed as ${CLOSURE_LABEL[
          result.closure_outcome
        ].toLowerCase()}.`,
        CLOSURE_TONE[result.closure_outcome],
      );
    },
    onError: (mutationError: unknown) => {
      // 409 is the record answering: this order was closed before, and the
      // message says when and how. Nothing here failed.
      if (mutationError instanceof ApiError && mutationError.status === 409) {
        setAlreadyClosed(readableClosureMessage(mutationError.message));
        setCloseOpen(false);
        return;
      }
      setFormError({
        tone: "danger",
        title: "Could not record this close-out",
        message:
          mutationError instanceof Error
            ? mutationError.message
            : "The server did not accept it. Try again.",
      });
    },
  });

  function openCloseDialog() {
    setOutcome("completed");
    setNote("");
    // The ordered total is the honest default: a buyer who counted something
    // different has to say so deliberately.
    setReceived(orderedQuantity > 0 ? String(orderedQuantity) : "");
    setFormError(null);
    setCloseOpen(true);
  }

  function submitClose() {
    if (noteMissing) {
      setFormError({
        tone: "warning",
        title: "This outcome needs a note",
        message:
          `Closing as ${CLOSURE_LABEL[outcome].toLowerCase()} is a claim that something ` +
          "went wrong, and the API rejects it without saying what. A reliability record " +
          "nobody can read back is not worth keeping.",
      });
      return;
    }
    if (receivedInvalid) {
      setFormError({
        tone: "warning",
        title: "Check the received quantity",
        message:
          "It has to be a whole number of units, zero or more. Leave it empty if nothing " +
          "was counted on receipt.",
      });
      return;
    }
    setFormError(null);
    closeMutation.mutate();
  }

  return (
    <>
      {/* Console chrome, not document: the printed page starts at the order. */}
      <PageHeader
        className="no-print"
        breadcrumb={
          <Link
            href={`/workflows/${id}`}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[#5f7280] transition-colors duration-200 hover:text-[#447f98]"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {workflow?.title ?? "Back to execution"}
          </Link>
        }
        title="Purchase order"
        description="The document the agent generated from the winning quote, validated against that quote and held at the approval gate until an administrator decided."
        actions={
          data ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                icon={<Printer className="size-3.5" />}
                onClick={() => window.print()}
                className="no-print"
              >
                Print
              </Button>
              {data.pdf_url && (
                <a
                  href={data.pdf_url}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(LINK_BUTTON, "no-print")}
                >
                  <Download className="size-3.5" aria-hidden />
                  Download PDF
                </a>
              )}
            </>
          ) : undefined
        }
      />

      <WorkflowNav workflowId={id} />

      <div className="mt-6">
        {isPending || explaining ? (
          <Card className="p-6">
            <LoadingBlock rows={5} />
          </Card>
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
            icon={
              isEscalated ? (
                <Megaphone className="size-6" />
              ) : (
                <FileText className="size-6" />
              )
            }
            title={
              isReimbursement
                ? "A reimbursement claim has no purchase order"
                : isEscalated
                  ? "This run stopped before it ordered anything"
                  : "No purchase order has been generated yet"
            }
            description={
              isReimbursement
                ? "This run is a reimbursement, not a procurement: nothing is ordered from a supplier. The agent totals the policy-compliant lines and renders a claim summary at generate_summary instead, then routes it to the same human approval gate. The execution screen shows the payable total and what the policy excluded."
                : isEscalated
                  ? `${asSentence(
                      workflow?.escalation_reason ??
                        "The agent stopped and asked for a person",
                    )} Nothing was ordered and nothing was committed. The agent only ever reads the catalog, so waiting changes nothing — the way forward is to put a price in it. Raise a quote request on the execution screen: every verified vendor is invited, each reply is written into that vendor's own catalog, and re-running this workflow reads it there. The agent never contacts a supplier.`
                  : "The agent writes the order at generate_po — after fetch_quotes has read the published catalog, the budget filter has dropped what the request cannot afford, and the scorer has picked a supplier. Until then there is nothing to show here."
            }
            action={
              <Link href={`/workflows/${id}`} className={PILL_LINK}>
                {isEscalated ? (
                  <>
                    <Megaphone className="size-3.5" aria-hidden />
                    Raise a quote request
                  </>
                ) : (
                  <>
                    <ArrowLeft className="size-3.5" aria-hidden />
                    Back to execution
                  </>
                )}
              </Link>
            }
          />
        ) : apiError?.isForbidden ? (
          <EmptyState
            icon={<Lock className="size-6" />}
            title="Buyer workflows are closed to vendor accounts"
            description="You are signed in as a supplier. Vendor accounts see their own purchase orders under the portal — never the buyer-side run that produced them."
          />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : !data ? null : (
          <div className="grid gap-5 lg:grid-cols-3">
            {/* ============================================================
                The document
                ============================================================ */}
            <Card variant="glass" className="animate-fade-up lg:col-span-2">
              {/* ---- Document header ---------------------------------- */}
              <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
                <div className="min-w-0">
                  <p className={MICRO}>Purchase order</p>
                  <p className="tnum mt-1 font-mono text-[26px] font-bold leading-tight tracking-[-0.02em] text-[#101828] sm:text-[30px]">
                    {data.po_number}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="text-[12.5px] text-[#5f7280]">
                      Issued {dateTime(data.created_at)}
                    </p>
                    <span className="no-print">
                      <CopyButton value={data.po_number} label="Copy number" />
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                  <StatusPill
                    tone={DELIVERY_STATUS_TONE[data.delivery_status] ?? "neutral"}
                    label={
                      DELIVERY_STATUS_LABEL[data.delivery_status] ??
                      humanise(data.delivery_status)
                    }
                  />
                  <p className={MICRO}>Total</p>
                  <p className="tnum text-[22px] font-bold leading-none tracking-[-0.03em] text-[#101828]">
                    {money(data.total_amount, data.currency)}
                  </p>
                </div>
              </header>

              {/* ---- Supplier ----------------------------------------- */}
              <div className="mt-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-t border-[#e7eff3] pt-5">
                <div className="min-w-0">
                  <p className={MICRO}>Supplier</p>
                  <p className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
                    {vendor?.name ?? "Supplier on file"}
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-[#7e8c94]">
                    {vendor
                      ? (vendor.legal_name ??
                        vendor.email ??
                        "No trading name or contact on the vendor record")
                      : vendorLoading
                        ? "Loading the vendor record…"
                        : "The vendor record did not load — the order below is the committed document either way."}
                  </p>
                </div>
                {vendor?.address && (
                  <p className="max-w-xs text-[12.5px] leading-relaxed text-[#5f7280] sm:text-right">
                    {vendor.address}
                  </p>
                )}
              </div>

              {/* ---- Regenerated note (printable — part of the record) - */}
              {data.generation_attempt > 1 && (
                <div className="mt-5 flex items-start gap-3 rounded-[18px] border border-[#fedf89] bg-[#fffaeb] px-4 py-3.5">
                  <RotateCcw
                    className="mt-px size-4 shrink-0 text-[#b54708]"
                    aria-hidden
                  />
                  <div className="min-w-0 text-[12.5px] leading-relaxed text-[#b54708]">
                    <p className="font-semibold">
                      Generation attempt {data.generation_attempt}
                    </p>
                    <p className="mt-0.5">
                      An earlier draft of this order failed the agent&apos;s own
                      validation, so the agent rebuilt it rather than passing the
                      wrong document on.{" "}
                      <Link
                        href={`/workflows/${id}/validation`}
                        className="font-semibold underline underline-offset-2"
                      >
                        See the validation report
                      </Link>
                      .
                    </p>
                  </div>
                </div>
              )}

              {/* ---- Terms -------------------------------------------- */}
              <section className="mt-6">
                <p className={cn(MICRO, "mb-3")}>Terms</p>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <TermTile
                    icon={<CalendarClock className="size-3.5" />}
                    label="Expected delivery"
                    value={
                      data.expected_delivery_date
                        ? dateOnly(data.expected_delivery_date)
                        : "Not specified"
                    }
                    muted={!data.expected_delivery_date}
                  />
                  <TermTile
                    icon={<Truck className="size-3.5" />}
                    label="Lead time"
                    value={
                      data.delivery_days == null
                        ? "Not specified"
                        : `${data.delivery_days} ${
                            data.delivery_days === 1 ? "day" : "days"
                          }`
                    }
                    muted={data.delivery_days == null}
                  />
                  <TermTile
                    icon={<ShieldCheck className="size-3.5" />}
                    label="Warranty"
                    value={
                      data.warranty_months == null
                        ? "Not specified"
                        : `${data.warranty_months} ${
                            data.warranty_months === 1 ? "month" : "months"
                          }`
                    }
                    muted={data.warranty_months == null}
                  />
                  <TermTile
                    icon={<Wallet className="size-3.5" />}
                    label="Payment terms"
                    value={data.payment_terms ?? "Not specified"}
                    muted={!data.payment_terms}
                  />
                </div>
              </section>

              {/* ---- Line items --------------------------------------- */}
              <section className="mt-7">
                <div className="mb-3 flex items-baseline justify-between gap-4">
                  <p className={MICRO}>Line items</p>
                  <p className="tnum text-[12px] text-[#7e8c94]">
                    {lines.length} {lines.length === 1 ? "line" : "lines"}
                  </p>
                </div>

                {lines.length === 0 ? (
                  <EmptyState
                    title="This order has no line items"
                    description="The order was written without any lines, which should not happen for a procurement run. The totals below are still the committed figures."
                  />
                ) : (
                  <Table minWidth={620}>
                    <thead>
                      <tr>
                        <Th className="w-10">#</Th>
                        <Th>Description</Th>
                        <Th>SKU</Th>
                        <Th align="right">Qty</Th>
                        <Th align="right">Unit price</Th>
                        <Th align="right">Line total</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line) => (
                        <Tr key={line.line_number}>
                          <Td className="tnum text-[12px] text-[#a3b6c0]">
                            {line.line_number}
                          </Td>
                          <Td className="font-medium">{line.description}</Td>
                          <Td>
                            {line.sku ? (
                              <Mono>{line.sku}</Mono>
                            ) : (
                              <span className="text-[#b3c4cc]">—</span>
                            )}
                          </Td>
                          <Td align="right">{line.quantity}</Td>
                          <Td align="right">
                            {money(line.unit_price, data.currency)}
                          </Td>
                          <Td align="right" className="font-semibold">
                            {money(line.line_total, data.currency)}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </section>

              {/* ---- Totals ------------------------------------------- */}
              <section className="mt-6 flex justify-end">
                <dl className="w-full max-w-[320px]">
                  <TotalRow
                    label="Subtotal"
                    value={money(data.subtotal, data.currency)}
                  />
                  <TotalRow label="Tax" value={money(data.tax, data.currency)} />
                  <div className="mt-2 border-t border-[#e0ebf0]" />
                  <TotalRow
                    label="Total"
                    value={money(data.total_amount, data.currency)}
                    emphasis
                  />
                </dl>
              </section>

              <p className="mt-7 border-t border-[#e7eff3] pt-4 text-[11.5px] leading-relaxed text-[#a3b6c0]">
                Generated by AgentFlow from the quote the agent selected, and
                validated against that same quote before it reached the approval
                gate. Amounts are stated in {data.currency}.
              </p>
            </Card>

            {/* ============================================================
                Console-side rail — never printed
                ============================================================ */}
            <aside className="no-print animate-fade-up space-y-5">
              {/* ---- Close out — the buyer's account, not the supplier's -- */}
              <Panel
                className="no-print"
                title="Close out"
                description="What the buyer recorded on receipt."
                icon={<ClipboardCheck className="size-[18px]" />}
              >
                <div className="space-y-4">
                  <p className="text-[12.5px] leading-relaxed text-[#5f7280]">
                    Delivery status is the{" "}
                    <span className="font-semibold text-[#243640]">supplier&apos;s</span>{" "}
                    account of this order, moved by the vendor in their own portal; the
                    close-out is the{" "}
                    <span className="font-semibold text-[#243640]">buyer&apos;s</span>,
                    recorded against the signed-in user. A vendor marking something
                    delivered and a buyer confirming it arrived are different claims — and
                    until this existed, every vendor reliability score rested on the
                    supplier&apos;s own report of its own performance.
                  </p>

                  <div className="glass-flat divide-y divide-[#e7eff3] rounded-[16px] px-3.5 py-1">
                    <ClaimRow
                      who="Supplier says"
                      source={
                        closeAdvancedSupplier
                          ? "Advanced to delivered by your clean close-out"
                          : "Set by the vendor in the portal"
                      }
                      value={
                        <StatusPill
                          size="sm"
                          tone={
                            DELIVERY_STATUS_TONE[
                              closeResult?.delivery_status ?? data.delivery_status
                            ] ?? "neutral"
                          }
                          label={
                            DELIVERY_STATUS_LABEL[
                              closeResult?.delivery_status ?? data.delivery_status
                            ] ?? humanise(closeResult?.delivery_status ?? data.delivery_status)
                          }
                        />
                      }
                    />
                    <ClaimRow
                      who="Buyer says"
                      source={
                        closeResult
                          ? `Recorded ${dateTime(closeResult.closed_at)}`
                          : alreadyClosed
                            ? "Recorded on this order before this session"
                            : "Recorded here, on receipt"
                      }
                      value={
                        closeResult ? (
                          <StatusPill
                            size="sm"
                            tone={CLOSURE_TONE[closeResult.closure_outcome]}
                            label={CLOSURE_LABEL[closeResult.closure_outcome]}
                          />
                        ) : alreadyClosed ? (
                          // The order IS closed — saying "not recorded yet"
                          // here would contradict the note directly below it.
                          <StatusPill size="sm" tone="neutral" label="Closed" />
                        ) : (
                          <span className="text-[12px] font-semibold text-[#a3b6c0]">
                            Not recorded yet
                          </span>
                        )
                      }
                    />
                  </div>

                  {closeResult ? (
                    <>
                      <div className="space-y-2.5 rounded-[16px] border border-[#e7eff3] bg-white/60 p-3.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[12.5px] text-[#7e8c94]">Received</span>
                          <span className="tnum text-[13px] font-semibold text-[#243640]">
                            {closeResult.received_quantity === null
                              ? "Not counted"
                              : `${formatNumber(
                                  closeResult.received_quantity,
                                )} of ${formatNumber(orderedQuantity)}`}
                          </span>
                        </div>
                        {closeResult.received_quantity !== null &&
                          closeResult.received_quantity < orderedQuantity && (
                            <p className="text-[11.5px] font-medium text-[#b54708]">
                              {formatNumber(
                                orderedQuantity - closeResult.received_quantity,
                              )}{" "}
                              short of the ordered total.
                            </p>
                          )}
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[12.5px] text-[#7e8c94]">Closed by</span>
                          <span className="text-[13px] font-semibold text-[#243640]">
                            {user?.fullName ?? user?.email ?? "You"}
                          </span>
                        </div>
                        {closeResult.closure_note && (
                          <div className="border-t border-[#eef4f7] pt-2.5">
                            <p className={MICRO}>Note</p>
                            <p className="mt-1 text-[12.5px] leading-relaxed text-[#243640]">
                              {closeResult.closure_note}
                            </p>
                          </div>
                        )}
                      </div>
                      <p className="text-[12px] leading-relaxed text-[#7e8c94]">
                        {closeAdvancedSupplier
                          ? "The vendor had not marked this delivered, so the clean completion advanced their status for them. Both records stand, and the row above says which of them moved it."
                          : closeResult.closure_outcome === "completed"
                            ? "The vendor had already marked this delivered, so nothing on their side changed. Both records stand — the vendor's account of the order, and yours."
                            : "The supplier's status is left exactly as the vendor set it: only a clean completion advances it, so the two claims stay separately auditable."}
                      </p>
                    </>
                  ) : alreadyClosed ? (
                    <Alert tone="brand" title="This order is already closed">
                      <p>{alreadyClosed}</p>
                      <p className="mt-2 opacity-90">
                        An order closes exactly once, so the button is spent. The note and
                        the counted quantity are on the order record; this screen cannot
                        show them yet, because the purchase-order endpoint does not return
                        the closure fields.
                      </p>
                    </Alert>
                  ) : (
                    <>
                      <Button
                        full
                        icon={<PackageCheck className="size-4" />}
                        onClick={openCloseDialog}
                      >
                        Close out this order
                      </Button>
                      <p className="text-[12px] leading-relaxed text-[#7e8c94]">
                        Closing an order the supplier never marked delivered is a normal
                        situation — goods routinely arrive before the paperwork. The
                        backend records the buyer&apos;s receipt either way, and advances
                        the supplier&apos;s delivery status to delivered only for a clean
                        completion, leaving the two claims separately auditable.
                      </p>
                    </>
                  )}
                </div>
              </Panel>

              <Panel
                title="PDF"
                description="A signed link, minted per request."
                icon={<Download className="size-[18px]" />}
              >
                {data.pdf_url ? (
                  <div className="space-y-3">
                    <a
                      href={data.pdf_url}
                      target="_blank"
                      rel="noreferrer"
                      className={cn(LINK_BUTTON, "h-11 w-full rounded-[14px] text-[13.5px]")}
                    >
                      <Download className="size-4" aria-hidden />
                      Download PDF
                    </a>
                    <p className="text-[12px] leading-relaxed text-[#7e8c94]">
                      The link is time-limited. If it stops working, reload this page
                      and a fresh one is signed.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[12.5px] font-semibold text-[#243640]">
                      No signed link available
                    </p>
                    <p className="text-[12px] leading-relaxed text-[#7e8c94]">
                      Either Supabase Storage is not configured in this environment or
                      the signed URL could not be minted. The purchase order itself is
                      unaffected — this page is the record, and it prints.
                    </p>
                  </div>
                )}
              </Panel>

              <Panel
                title="How this document was produced"
                icon={<ReceiptText className="size-[18px]" />}
              >
                <div className="space-y-3 text-[12.5px] leading-relaxed text-[#5f7280]">
                  <p>
                    <Mono>generate_po</Mono> wrote it from the winning quote,{" "}
                    <Mono>validate_po</Mono> checked it line by line against that
                    quote, and <Mono>route_approval</Mono> stopped the graph until an
                    administrator decided. The agent never approves its own order.
                  </p>
                  <p className="flex items-center gap-2 text-[#243640]">
                    <BadgeCheck className="size-4 shrink-0 text-[#447f98]" aria-hidden />
                    <span className="font-semibold">
                      {data.generation_attempt > 1
                        ? `Rebuilt by self-correction — attempt ${data.generation_attempt}`
                        : "Accepted on the first generation"}
                    </span>
                  </p>
                </div>
              </Panel>

              <Panel title="Identifiers">
                <dl className="divide-y divide-[#eef4f7]">
                  <div className="flex items-center justify-between gap-4 py-2">
                    <dt className="text-[12.5px] text-[#7e8c94]">Order</dt>
                    <dd className="flex items-center gap-1">
                      <Mono>{data.id.slice(0, 8)}</Mono>
                      <CopyButton value={data.id} label="Copy" />
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
                    <dt className="text-[12.5px] text-[#7e8c94]">Quote</dt>
                    <dd className="flex items-center gap-1">
                      <Mono>{data.quote_id.slice(0, 8)}</Mono>
                      <CopyButton value={data.quote_id} label="Copy" />
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 py-2">
                    <dt className="text-[12.5px] text-[#7e8c94]">Vendor</dt>
                    <dd className="flex items-center gap-1">
                      <Mono>{data.vendor_id.slice(0, 8)}</Mono>
                      <CopyButton value={data.vendor_id} label="Copy" />
                    </dd>
                  </div>
                </dl>
              </Panel>
            </aside>
          </div>
        )}
      </div>

      {/* ================================================================
          Close-out dialog. Rendered outside the document, and wrapped in
          `no-print`, so a Ctrl+P with the dialog open still prints the order
          rather than the form and its backdrop.
          ================================================================ */}
      {data && (
        <div className="no-print">
          <Modal
            open={closeOpen}
            onClose={() => {
              if (!closeMutation.isPending) setCloseOpen(false);
            }}
            title={`Close out ${data.po_number}`}
            description="Your account of what arrived, recorded against your sign-in. The supplier's own delivery status is left as the vendor set it unless this closes cleanly."
            width={600}
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => setCloseOpen(false)}
                  disabled={closeMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  loading={closeMutation.isPending}
                  icon={<PackageCheck className="size-4" />}
                  onClick={submitClose}
                >
                  Record close-out
                </Button>
              </>
            }
          >
            <div className="space-y-5 pb-2">
              <Field label="Outcome" hint={selectedOption.hint}>
                <OutcomeChoice
                  value={outcome}
                  onChange={(next) => {
                    setOutcome(next);
                    setFormError(null);
                  }}
                  disabled={closeMutation.isPending}
                />
              </Field>

              <Field
                label="Received quantity"
                htmlFor="po-close-received"
                hint={`What was actually counted on receipt. This order asks for ${formatNumber(
                  orderedQuantity,
                )} ${orderedQuantity === 1 ? "unit" : "units"} across ${lines.length} ${
                  lines.length === 1 ? "line" : "lines"
                }.`}
              >
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <Input
                      id="po-close-received"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      value={received}
                      invalid={receivedInvalid}
                      disabled={closeMutation.isPending}
                      onChange={(event) => {
                        setReceived(event.target.value);
                        setFormError(null);
                      }}
                      className="tnum max-w-[150px]"
                    />
                    <span className="tnum shrink-0 text-[12.5px] text-[#7e8c94]">
                      of{" "}
                      <span className="font-semibold text-[#243640]">
                        {formatNumber(orderedQuantity)}
                      </span>{" "}
                      ordered
                    </span>
                  </div>
                  {shortfall > 0 && (
                    <p className="text-[11.5px] font-medium text-[#b54708]">
                      {formatNumber(shortfall)} short of the ordered total. It is filed as
                      the buyer&apos;s count against your sign-in, not the supplier&apos;s
                      own report — which is the only footing on which a quantity-accuracy
                      figure means anything.
                    </p>
                  )}
                </div>
              </Field>

              <Field
                label="Note"
                htmlFor="po-close-note"
                required={noteRequired(outcome)}
                hint={
                  noteRequired(outcome)
                    ? "Required for this outcome — the API refuses a close-out that says something went wrong without saying what."
                    : "Optional. Anything the next person reading this order should know."
                }
              >
                <Textarea
                  id="po-close-note"
                  value={note}
                  maxLength={2000}
                  invalid={noteMissing && formError !== null}
                  disabled={closeMutation.isPending}
                  onChange={(event) => {
                    setNote(event.target.value);
                    setFormError(null);
                  }}
                  placeholder={selectedOption.placeholder}
                />
              </Field>

              {formError && (
                <Alert tone={formError.tone} title={formError.title}>
                  {formError.message}
                </Alert>
              )}

              {/* The last line before the call goes out: what is about to be
                  recorded, against which order, by whom. */}
              <div className="rounded-[16px] border border-[#d6ebf3] bg-[#e9f3f8]/70 px-4 py-3">
                <p className="text-[12.5px] leading-relaxed text-[#38677b]">
                  You are closing{" "}
                  <span className="tnum font-mono font-semibold text-[#243640]">
                    {data.po_number}
                  </span>{" "}
                  as{" "}
                  <span className="font-semibold text-[#243640]">
                    {CLOSURE_LABEL[outcome].toLowerCase()}
                  </span>
                  {receivedNumber !== null && !receivedInvalid ? (
                    <>
                      , with{" "}
                      <span className="tnum font-semibold text-[#243640]">
                        {formatNumber(receivedNumber)}
                      </span>{" "}
                      of {formatNumber(orderedQuantity)} received
                    </>
                  ) : null}
                  . Recorded against{" "}
                  <span className="font-semibold text-[#243640]">
                    {user?.fullName ?? user?.email ?? "your account"}
                  </span>
                  , and a supplier with a portal account is notified of how it closed.
                </p>
              </div>
            </div>
          </Modal>
        </div>
      )}
    </>
  );
}
