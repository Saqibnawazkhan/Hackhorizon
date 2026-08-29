"use client";

/**
 * The buyer's side of a quote request — the way out of an escalated workflow.
 *
 * A procurement run escalates when nothing in the catalog matches the request,
 * or when nothing came in under budget. That used to be terminal: the catalog
 * held no answer and there was no way to ask for one.
 *
 * Now the buyer raises a quote request. Every verified vendor in the
 * organisation is invited and notified, each replies with a price per line,
 * and a reply the vendor publishes is written into THAT VENDOR'S CATALOG —
 * visible, `source='rfq'`. The buyer then re-runs the workflow:
 * `POST /workflows/{id}/run` already accepts a workflow in `escalated`, and the
 * agent picks the new prices up through the ordinary catalog path.
 *
 * THE AGENT IS UNCHANGED. It does not contact a vendor, wait on one, or read a
 * reply. It still only ever READS THE CATALOG, which is what keeps a run fast,
 * deterministic and replayable — no node changed, no edge changed, no new tool.
 * The vendor writes on its own schedule, exactly as the vendor portal already
 * does. Nothing on this screen should suggest otherwise.
 *
 * Two consequences drive most of the copy below.
 *
 *  - `published_to_catalog` is load-bearing, not a detail. A reply that was
 *    recorded but not published is INVISIBLE to the agent: it cannot be scored,
 *    cannot be selected, and the buyer would have to read it by hand. So an
 *    unpublished reply is a warning row, not a success row.
 *  - `is_actionable` is true only once at least one reply is live in the
 *    catalog. Re-running before that reproduces the same escalation exactly,
 *    because the agent would re-read the same catalog it already read.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  Clock,
  ExternalLink,
  EyeOff,
  Megaphone,
  Play,
  Send,
  Store,
} from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import {
  Alert,
  Button,
  ErrorState,
  Field,
  Modal,
  Mono,
  Panel,
  Select,
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
  dateTime,
  money,
  number as fmtNumber,
  parseDate,
  relativeTime,
  type Tone,
} from "@/lib/format";
import type {
  QuoteRequest,
  QuoteRequestStatus,
  QuoteResponse,
  QuoteResponseLine,
  WorkflowStatus,
} from "@/lib/types";

/* ==========================================================================
   Vocabulary
   ========================================================================== */

/** The deadlines the API accepts as `respond_within_hours`. */
const DEADLINE_OPTIONS: { hours: number; label: string }[] = [
  { hours: 24, label: "24 hours" },
  { hours: 48, label: "48 hours" },
  { hours: 72, label: "72 hours" },
  { hours: 168, label: "1 week" },
];

const DEFAULT_HOURS = 48;

const REQUEST_STATUS_LABEL: Record<QuoteRequestStatus, string> = {
  open: "Taking replies",
  closed: "Replies closed",
  cancelled: "Cancelled",
  expired: "Deadline passed",
};

const REQUEST_STATUS_TONE: Record<QuoteRequestStatus, Tone> = {
  open: "brand",
  closed: "neutral",
  cancelled: "muted",
  expired: "warning",
};

/* ==========================================================================
   Small formatters
   ========================================================================== */

function plural(value: number, singular: string, many = `${singular}s`): string {
  return `${fmtNumber(value)} ${value === 1 ? singular : many}`;
}

function deliveryTerm(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "Same day";
  return plural(value, "day");
}

/** A warranty is quoted in years far more often than in months. */
function warrantyTerm(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "None";
  if (value % 12 === 0) return plural(value / 12, "year");
  return plural(value, "month");
}

/**
 * How long is left on the deadline, looking forward.
 *
 * `relativeTime` only looks backwards — a future timestamp falls into its
 * "just now" branch — and `duration()` renders a run's milliseconds, which is
 * the wrong scale for days. So the deadline gets its own reading. Returns null
 * once the moment has passed, which the caller says in words instead.
 */
function timeLeft(iso: string | null): string | null {
  const closes = parseDate(iso);
  if (!closes) return null;
  const remaining = closes.getTime() - Date.now();
  if (remaining <= 0) return null;
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${plural(minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${plural(hours, "hour")}`;
  return `in ${plural(Math.round(hours / 24), "day")}`;
}

/** What one vendor's row is saying, in one place. */
function readReply(response: QuoteResponse): {
  label: string;
  tone: Tone;
  icon: ReactNode;
} {
  if (response.status === "responded") {
    return response.published_to_catalog
      ? {
          label: "Quoted",
          tone: "positive",
          icon: <CheckCircle2 className="size-3.5" />,
        }
      : {
          label: "Quoted, not published",
          tone: "warning",
          icon: <EyeOff className="size-3.5" />,
        };
  }
  if (response.status === "declined") {
    return { label: "Declined", tone: "muted", icon: <Ban className="size-3.5" /> };
  }
  return { label: "No reply yet", tone: "muted", icon: <Clock className="size-3.5" /> };
}

/* ==========================================================================
   Pieces
   ========================================================================== */

/** The deadline, read forwards. Its whole job is to stop a request parking. */
function DeadlineNote({ request }: { request: QuoteRequest }) {
  const open = request.status === "open";
  const left = open ? timeLeft(request.closes_at) : null;

  // `expire_overdue` stamps `closed_at` on an expired request exactly as a
  // manual close does, so the timestamp alone cannot tell the two apart — the
  // status is what says whether a person stopped this or the clock did.
  const text = !open
    ? request.status === "expired"
      ? request.closed_at
        ? `Deadline passed ${relativeTime(request.closed_at)}`
        : "The deadline has passed"
      : request.closed_at
        ? `Closed ${relativeTime(request.closed_at)}`
        : "Closed"
    : left
      ? `Replies close ${left}`
      : request.closes_at
        ? "The deadline has passed"
        : "No deadline set";

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#5f7280]"
      title={
        request.closes_at
          ? `Deadline ${dateTime(request.closes_at)}`
          : undefined
      }
    >
      <Clock className="size-3.5 text-[#7e8c94]" />
      {text}
    </span>
  );
}

/** One quoted line, opened out. This is the offer the catalog now holds. */
function LineCard({
  line,
  currency,
}: {
  line: QuoteResponseLine;
  currency: string;
}) {
  if (!line.available) {
    return (
      <div className="rounded-[16px] border border-dashed border-[#dbe7ec] bg-white/40 px-3.5 py-3">
        <p className="text-[12.5px] font-semibold text-[#5f7280]">
          {line.request_item_name}
        </p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#7e8c94]">
          This supplier cannot supply this line.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[16px] bg-white/70 px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-[#243640]">
            {line.title ?? line.request_item_name}
          </p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#7e8c94]">
            Against <span className="text-[#5f7280]">{line.request_item_name}</span>
            {line.sku ? (
              <>
                {" · "}
                <Mono>{line.sku}</Mono>
              </>
            ) : null}
          </p>
        </div>
        <p className="tnum shrink-0 text-[13px] font-bold text-[#243640]">
          {money(line.line_total, currency)}
        </p>
      </div>

      <dl className="mt-2.5 flex flex-wrap gap-x-6 gap-y-1.5 border-t border-[#eef4f7] pt-2.5">
        {[
          { label: "Unit price", value: money(line.unit_price, currency) },
          { label: "Quantity", value: fmtNumber(line.quantity) },
          { label: "Delivery", value: deliveryTerm(line.delivery_days) },
          { label: "Warranty", value: warrantyTerm(line.warranty_months) },
        ].map((cell) => (
          <div key={cell.label}>
            <dt className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
              {cell.label}
            </dt>
            <dd className="tnum mt-0.5 text-[12.5px] font-semibold text-[#243640]">
              {cell.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ==========================================================================
   The panel
   ========================================================================== */
export function QuoteRequestPanel({
  workflowId,
  status,
  escalationReason,
  className,
}: {
  workflowId: string;
  status: WorkflowStatus;
  escalationReason: string | null;
  /**
   * Applied to whatever this renders — and it renders nothing at all on a
   * workflow with no request. The caller therefore cannot wrap it in a spaced
   * container without leaving a stray gap, so the spacing comes through here.
   */
  className?: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [askOpen, setAskOpen] = useState(false);
  const [note, setNote] = useState("");
  const [hours, setHours] = useState(DEFAULT_HOURS);
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["quote-request", workflowId],
    queryFn: () => api.getQuoteRequest(workflowId),
    // A 404 here is an answer, not a fault: no request has been raised yet.
    // Retrying it would only delay the panel that offers to raise one.
    retry: false,
    // Replies arrive from a person in a different application on their own
    // schedule — there is no socket frame for "a vendor answered". While the
    // request is taking replies, ask again periodically so the table fills in
    // without the buyer reloading. It stops the moment the request closes.
    refetchInterval: (current) =>
      current.state.data?.status === "open" ? 20_000 : false,
  });

  const request = query.data;
  const failure = query.error;
  const notFound = failure instanceof ApiError && failure.isNotFound;
  const forbidden = failure instanceof ApiError && failure.isForbidden;
  const unavailable = failure instanceof ApiError && failure.isUnavailable;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["quote-request", workflowId] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      api.createQuoteRequest(workflowId, {
        note: note.trim() ? note.trim() : null,
        respond_within_hours: hours,
      }),
    onSuccess: (created) => {
      // Seed the cache so the panel switches to the request the instant the
      // ask lands, then reconcile against the server on the next tick.
      queryClient.setQueryData(["quote-request", workflowId], created);
      invalidate();
      setAskOpen(false);
      setNote("");
      toast(
        `Asked ${plural(created.invited_count, "supplier")} for a price.`,
        "positive",
      );
    },
    // Deliberately not a toast: the two failures worth reading — no verified
    // vendor to ask, and a rejected field — belong beside the form that caused
    // them, and the modal stays open so the buyer can act on either.
  });

  const closeMutation = useMutation({
    mutationFn: (requestId: string) => api.closeQuoteRequest(requestId),
    onSuccess: () => {
      // Invalidate rather than seed: the close route builds its payload
      // without the workflow, so its `workflow_title` comes back null. Refetch
      // the complete record instead of caching a thinner one.
      invalidate();
      toast("Replies are closed. Anything already published still counts.", "neutral");
    },
    onError: (error: unknown) => {
      toast(
        error instanceof Error ? error.message : "Could not close that request.",
        "danger",
      );
    },
  });

  const rerunMutation = useMutation({
    mutationFn: () => api.runWorkflow(workflowId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflow", workflowId] });
      void queryClient.invalidateQueries({ queryKey: ["quote-request", workflowId] });
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      toast(
        "Running again. The agent is re-reading the catalog, with the published quotes in it.",
        "positive",
      );
    },
    onError: (error: unknown) => {
      toast(
        error instanceof Error ? error.message : "Could not start that run.",
        "danger",
      );
    },
  });

  const escalated = status === "escalated";

  /* ---------------------------------------------------------------- loading */
  // `isPending`, not `isLoading`: the two differ exactly when the query is
  // paused — offline, or a browser holding the request — where `isLoading` is
  // already false with no data and no error. Reading that as "nothing has been
  // asked" would offer to raise a request we have not established is missing.
  if (query.isPending) {
    // On anything but an escalated workflow the likeliest answer is 404 and
    // therefore nothing at all — a skeleton there would promise a panel that
    // never arrives.
    return escalated ? (
      <Skeleton className={cn("h-[210px] rounded-[28px]", className)} />
    ) : null;
  }

  /* ------------------------------------------------- nothing raised, or lost */
  if (!request) {
    // A workflow that has not escalated and has no request has nothing to say
    // here, including about a failed read.
    if (!escalated) return null;

    if (forbidden) {
      return (
        <Alert
          tone="neutral"
          title="Quote requests are a buyer view"
          className={className}
        >
          Your session does not carry a buyer role, so the API declined this
          read. A supplier only ever sees its own invitation, never the whole
          request or what a competitor quoted.
        </Alert>
      );
    }

    if (unavailable) {
      return (
        <Alert
          tone="neutral"
          title="Asking vendors is not available right now"
          className={className}
        >
          The service behind quote requests is not reachable. Nothing has been
          lost — this workflow stays escalated, and the ask can be raised once
          the dependency is back.
        </Alert>
      );
    }

    if (failure && !notFound) {
      return (
        <ErrorState
          error={failure}
          className={className}
          onRetry={() => void query.refetch()}
        />
      );
    }

    /* ------------------------------------------------------------- STATE 1
       Escalated, nothing asked yet. */
    return (
      <>
        <Panel
          className={cn("animate-fade-up", className)}
          icon={<Megaphone className="size-4" />}
          title="Ask vendors for a price"
          description="The agent found no answer in the catalog. It can only read what is already there — so the way forward is to put something new in it."
          bodyClassName="pt-4"
          actions={
            <StatusPill size="sm" tone="warning" label="Needs a decision" />
          }
        >
          <div className="rounded-[18px] border border-[#fedf89] bg-[#fffaeb] px-4 py-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#b54708]">
              Why this stopped
            </p>
            <p className="mt-1 text-[13px] font-semibold leading-relaxed text-[#b54708]">
              {escalationReason ??
                "The agent stopped and asked for a person."}
            </p>
          </div>

          <p className="mt-4 text-[12.5px] leading-relaxed text-[#5f7280]">
            Raise a quote request and every verified vendor in your organisation
            is invited and notified. Each one replies with a price per line, and
            a reply the vendor publishes is written straight into that
            vendor&apos;s catalog. A reply they keep unpublished stays here for
            you to read — the agent will not see it.
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-[#5f7280]">
            Then re-run this workflow. The agent does not contact anyone and
            never has — it reads the catalog, and by then the catalog holds
            prices it did not hold before. Nothing about the agent changes:
            same nodes, same tools, same run.
          </p>

          <div className="mt-5">
            <Button
              icon={<Send className="size-3.5" />}
              onClick={() => setAskOpen(true)}
            >
              Request quotes from vendors
            </Button>
          </div>
        </Panel>

        <AskModal
          open={askOpen}
          note={note}
          hours={hours}
          pending={createMutation.isPending}
          error={createMutation.error}
          onNote={setNote}
          onHours={setHours}
          onClose={() => {
            setAskOpen(false);
            createMutation.reset();
          }}
          onSubmit={() => createMutation.mutate()}
        />
      </>
    );
  }

  /* ------------------------------------------------------------------ STATE 2
     A request exists. */
  const responses = Array.isArray(request.responses) ? request.responses : [];
  const live = responses.filter(
    (row) => row.status === "responded" && row.published_to_catalog,
  );
  const unpublished = responses.filter(
    (row) => row.status === "responded" && !row.published_to_catalog,
  );
  const declined = responses.filter((row) => row.status === "declined");
  const silent = responses.filter((row) => row.status === "invited");
  const isOpen = request.status === "open";

  return (
    <>
      <Panel
        className={cn("animate-fade-up", className)}
        icon={<Store className="size-4" />}
        title="Quote request"
        description="Every verified vendor was invited. A reply only reaches the agent once the vendor publishes it to their catalog — the one place the agent reads."
        bodyClassName="pt-4"
        actions={
          isOpen ? (
            <Button
              size="sm"
              variant="secondary"
              loading={closeMutation.isPending}
              onClick={() => closeMutation.mutate(request.id)}
            >
              Stop taking replies
            </Button>
          ) : escalated ? (
            // Replies are closed and the workflow is still stuck. Without this
            // the screen is a dead end again — which is the one thing this
            // feature exists to remove. A closed request does not block a new
            // one: only an OPEN request is reused, so this raises a fresh ask.
            <Button
              size="sm"
              variant="secondary"
              icon={<Send className="size-3.5" />}
              onClick={() => setAskOpen(true)}
            >
              Ask again
            </Button>
          ) : undefined
        }
      >
        {/* --------------------------------------------------------- header */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13.5px] font-semibold tracking-[-0.01em] text-[#243640]">
              {request.summary_line}
            </p>
            <StatusPill
              size="sm"
              label={REQUEST_STATUS_LABEL[request.status]}
              tone={REQUEST_STATUS_TONE[request.status]}
            />
          </div>
          <DeadlineNote request={request} />
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#7e8c94]">
          The deadline is what stops an escalated workflow parking forever on a
          vendor who is never coming. When it passes, replies close on their own
          and anything already published still counts.
        </p>

        {request.note && (
          <p className="mt-3 rounded-[16px] border-l-[3px] border-l-[#b9d8e1] bg-white/60 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[#3b4d57]">
            {request.note}
          </p>
        )}

        {/* --------------------------------------------------------- STATE 3
            What to do about the replies. */}
        <div className="mt-4">
          {request.is_actionable ? (
            status === "escalated" ? (
              <div className="rounded-[20px] border border-[#a6f4c5] bg-[#ecfdf3] px-4 py-4">
                <p className="flex items-center gap-2 text-[13.5px] font-semibold text-[#067647]">
                  <CheckCircle2 className="size-4 shrink-0" />
                  {plural(live.length, "supplier")}{" "}
                  {live.length === 1 ? "has" : "have"} published prices
                </p>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#067647]/85">
                  Those prices are in the catalog now. Re-run this workflow and
                  the agent will read them, score them against the same four
                  criteria as any other quote, and pick a winner — the ordinary
                  path, on data that did not exist when it stopped.
                </p>
                <div className="mt-3.5">
                  <Button
                    variant="success"
                    icon={<Play className="size-3.5" />}
                    loading={rerunMutation.isPending}
                    onClick={() => rerunMutation.mutate()}
                  >
                    Re-run with these quotes
                  </Button>
                </div>
              </div>
            ) : status === "running" ? (
              <Alert tone="brand" title="Running again" icon={<Play className="size-4" />}>
                The agent is re-reading the catalog with the published quotes in
                it. Progress is on the timeline beside this panel.
              </Alert>
            ) : (
              <Alert tone="positive" title="These quotes have been picked up">
                {plural(live.length, "published reply", "published replies")} sit in
                the catalog, and this workflow has moved on to{" "}
                {WORKFLOW_STATUS_LABEL[status].toLowerCase()}. The prices stay in
                the catalog for whatever is requested next.
              </Alert>
            )
          ) : responses.some((row) => row.status === "responded") ? (
            <Alert tone="warning" title="Nothing here is visible to the agent yet">
              {plural(unpublished.length, "reply", "replies")} came back without
              being published to the vendor&apos;s catalog. The agent reads the
              catalog and nothing else, so re-running now would read exactly what
              it read before and reproduce this same escalation. Ask those
              suppliers to publish their prices, or work from their figures by
              hand.
            </Alert>
          ) : declined.length > 0 && silent.length === 0 ? (
            <Alert tone="neutral" title="Everyone who answered declined">
              No invited supplier can supply this. Re-running would reproduce the
              same escalation — the catalog is unchanged. Widening the request or
              verifying another vendor is the way forward.
            </Alert>
          ) : isOpen ? (
            <Alert tone="neutral" title="Waiting on suppliers" icon={<Clock className="size-4" />}>
              No price has come back yet. Re-running before a reply is published
              would read the same catalog the agent already read and land in the
              same place, so this panel waits rather than offering it.
            </Alert>
          ) : (
            // Replies are closed and nothing usable arrived. Saying "waiting"
            // here would be false — nobody else is coming.
            <Alert
              tone="warning"
              title="Replies closed without a usable price"
              icon={<Clock className="size-4" />}
            >
              Nothing was published to a catalog before this request ended, so the
              agent would read exactly what it read before and stop in the same
              place. Asking again — with a longer deadline, or once another
              supplier is verified — is what changes the answer.
            </Alert>
          )}
        </div>

        {/* ---------------------------------------------------------- table */}
        <div className="mt-5">
          <Table minWidth={860}>
            <thead>
              <tr>
                <Th>Vendor</Th>
                <Th>Reply</Th>
                <Th align="right">Total</Th>
                <Th align="right">Delivery</Th>
                <Th align="right">Warranty</Th>
                <Th>Agent can see it</Th>
                <Th align="right">Replied</Th>
              </tr>
            </thead>
            <tbody>
              {responses.length === 0 && (
                <tr>
                  <Td colSpan={7} className="py-6 text-center text-[12.5px] text-[#7e8c94]">
                    This request reached no one. A quote request only goes to
                    verified vendors, and none was on record when it was raised.
                  </Td>
                </tr>
              )}
              {responses.map((response) => {
                const reply = readReply(response);
                const quoted = response.status === "responded";
                const lines = Array.isArray(response.lines) ? response.lines : [];
                const openRow = expanded === response.id;
                const currency = response.currency ?? request.currency;

                const expandable = quoted && lines.length > 0;

                return [
                  <Tr
                    key={response.id}
                    className={cn(
                      quoted && !response.published_to_catalog && "bg-[#fffaeb]/70",
                    )}
                  >
                    <Td>
                      {expandable ? (
                        <button
                          type="button"
                          aria-expanded={openRow}
                          title={
                            openRow
                              ? "Hide what this vendor quoted"
                              : "Show what this vendor quoted"
                          }
                          onClick={() => setExpanded(openRow ? null : response.id)}
                          className="-ml-1 flex items-center gap-1.5 rounded-[10px] px-1 py-0.5 text-left text-[13px] font-semibold text-[#243640] transition-colors duration-200 hover:bg-white/70 hover:text-[#38677b]"
                        >
                          <ChevronDown
                            className={cn(
                              "size-3.5 shrink-0 text-[#a3b6c0] transition-transform duration-200",
                              openRow && "rotate-180",
                            )}
                            aria-hidden
                          />
                          {response.vendor_name ?? "Unnamed vendor"}
                        </button>
                      ) : (
                        <span
                          className={cn(
                            "font-semibold",
                            quoted ? "text-[#243640]" : "text-[#5f7280]",
                          )}
                        >
                          {response.vendor_name ?? "Unnamed vendor"}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <StatusPill
                        size="sm"
                        dot={false}
                        tone={reply.tone}
                        label={
                          <span className="inline-flex items-center gap-1">
                            {reply.icon}
                            {reply.label}
                          </span>
                        }
                      />
                      {response.status === "declined" && response.decline_reason && (
                        <p className="mt-1 max-w-[220px] text-[11px] leading-relaxed text-[#7e8c94]">
                          {response.decline_reason}
                        </p>
                      )}
                    </Td>
                    <Td
                      align="right"
                      className={quoted ? "font-semibold" : "text-[#a3b6c0]"}
                    >
                      {quoted ? money(response.total_amount, currency) : "—"}
                    </Td>
                    <Td align="right" className={quoted ? undefined : "text-[#a3b6c0]"}>
                      {quoted ? deliveryTerm(response.delivery_days) : "—"}
                    </Td>
                    <Td align="right" className={quoted ? undefined : "text-[#a3b6c0]"}>
                      {quoted ? warrantyTerm(response.warranty_months) : "—"}
                    </Td>
                    <Td>
                      {!quoted ? (
                        <span className="text-[12px] text-[#a3b6c0]">—</span>
                      ) : response.published_to_catalog ? (
                        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#067647]">
                          <CheckCircle2 className="size-3.5 shrink-0" />
                          In the catalog
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#b54708]">
                          <EyeOff className="size-3.5 shrink-0" />
                          Not published
                        </span>
                      )}
                    </Td>
                    <Td align="right" className="text-[12px] text-[#7e8c94]">
                      {response.responded_at ? (
                        <span title={dateTime(response.responded_at)}>
                          {relativeTime(response.responded_at)}
                        </span>
                      ) : (
                        <span title={`Invited ${dateTime(response.invited_at)}`}>
                          Silent
                        </span>
                      )}
                    </Td>
                  </Tr>,

                  openRow ? (
                    <tr key={`${response.id}-lines`} className="animate-fade-in">
                      <Td colSpan={7} className="bg-white/45">
                        {!response.published_to_catalog && (
                          <div className="mb-3 rounded-[16px] border border-[#fedf89] bg-[#fffaeb] px-3.5 py-3">
                            <p className="flex items-center gap-2 text-[12.5px] font-semibold text-[#b54708]">
                              <EyeOff className="size-3.5 shrink-0" />
                              The agent cannot see this reply
                            </p>
                            <p className="mt-1 text-[11.5px] leading-relaxed text-[#b54708]/85">
                              This supplier recorded a price but did not publish it
                              to its catalog. The agent reads the catalog and
                              nothing else, so these figures cannot be scored or
                              selected — they exist only for you to read here and
                              act on by hand.
                            </p>
                            {/* "Ask them to publish" is only advice if there is a
                                way to reach them, and the supplier record is
                                where the contact details live. */}
                            <Link
                              href={`/vendors/${response.vendor_id}`}
                              className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-semibold text-[#b54708] underline decoration-[#fedf89] underline-offset-2 transition-colors hover:decoration-[#b54708]"
                            >
                              Open this supplier
                              <ExternalLink className="size-3" />
                            </Link>
                          </div>
                        )}

                        {response.note && (
                          <p className="mb-3 rounded-[16px] border-l-[3px] border-l-[#b9d8e1] bg-white/70 px-3.5 py-2.5 text-[12px] leading-relaxed text-[#3b4d57]">
                            {response.note}
                          </p>
                        )}

                        <div className="space-y-2">
                          {lines.map((line, index) => (
                            <LineCard
                              key={`${line.request_item_name}-${line.sku ?? index}`}
                              line={line}
                              currency={currency}
                            />
                          ))}
                        </div>
                      </Td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </Table>

          {responses.length > 0 && (
            <p className="mt-3.5 text-[11.5px] leading-relaxed text-[#7e8c94]">
              {silent.length > 0 ? (
                <>
                  {plural(silent.length, "invited supplier")}{" "}
                  {silent.length === 1 ? "has" : "have"} not answered. They are
                  listed because silence is information: it says who was asked,
                  not just who replied.
                </>
              ) : (
                <>
                  Every invited supplier has answered. A reply only reaches the
                  agent once it is published to that vendor&apos;s catalog.
                </>
              )}
            </p>
          )}
        </div>
      </Panel>

      {/* Reachable from "Ask again" once replies have closed on a workflow that
          is still escalated. The same modal, the same mutation — a closed
          request is not reused, so this raises a fresh one. */}
      <AskModal
        open={askOpen}
        note={note}
        hours={hours}
        pending={createMutation.isPending}
        error={createMutation.error}
        onNote={setNote}
        onHours={setHours}
        onClose={() => {
          setAskOpen(false);
          createMutation.reset();
        }}
        onSubmit={() => createMutation.mutate()}
      />
    </>
  );
}

/* ==========================================================================
   The ask
   ========================================================================== */
function AskModal({
  open,
  note,
  hours,
  pending,
  error,
  onNote,
  onHours,
  onClose,
  onSubmit,
}: {
  open: boolean;
  note: string;
  hours: number;
  pending: boolean;
  error: unknown;
  onNote: (next: string) => void;
  onHours: (next: number) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  // 409 is the API saying there is nobody to ask — an answer with an action
  // behind it, not a fault, so it is toned as a warning and linked onwards.
  const nobodyToAsk = error instanceof ApiError && error.status === 409;
  const message =
    error instanceof Error ? error.message : "Something went wrong.";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Request quotes from vendors"
      description="Every verified vendor in your organisation is invited and notified. Each replies with a price per line, and a reply they publish is written into their catalog — which is what makes it visible to the agent on the next run."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            icon={<Send className="size-3.5" />}
            loading={pending}
            onClick={onSubmit}
          >
            Send the request
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-2">
        {error !== null && error !== undefined && (
          <Alert
            tone={nobodyToAsk ? "warning" : "danger"}
            title={
              nobodyToAsk ? "There is nobody to ask yet" : "Could not send that request"
            }
          >
            {message}
            {nobodyToAsk && (
              <p className="mt-2">
                Only verified vendors are invited — the same rule that decides
                which suppliers the agent may quote at all.{" "}
                <Link
                  href="/vendors"
                  className="font-semibold underline decoration-[#fedf89] underline-offset-2"
                >
                  Open the vendor directory
                </Link>{" "}
                to add or verify one.
              </p>
            )}
          </Alert>
        )}

        <Field
          label="A note for the vendors"
          htmlFor="rfq-note"
          hint="Optional. Anything the line items do not already say — a delivery window, a required standard, a brand that will not do."
        >
          <Textarea
            id="rfq-note"
            value={note}
            maxLength={1000}
            placeholder="We need these on site before the end of the month."
            onChange={(event) => onNote(event.target.value)}
          />
        </Field>

        <Field
          label="Replies close after"
          htmlFor="rfq-deadline"
          hint="The deadline exists so an escalated workflow cannot park forever waiting on a vendor who is never coming. When it passes, the request expires on its own."
        >
          <Select
            id="rfq-deadline"
            value={String(hours)}
            onChange={(event) => onHours(Number(event.target.value))}
          >
            {DEADLINE_OPTIONS.map((option) => (
              <option key={option.hours} value={option.hours}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <p className="text-[11.5px] leading-relaxed text-[#7e8c94]">
          Asking twice does not raise a second request: a workflow has at most
          one open ask, so the replies stay in one place rather than being split
          across two you would have to reconcile.
        </p>
      </div>
    </Modal>
  );
}
