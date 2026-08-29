"use client";

/**
 * The vendor's quote requests — the one screen where a supplier wins business
 * it was never listed for.
 *
 * A buyer's workflow escalated: nothing in the catalog matched, or nothing
 * came in under budget. That used to be terminal. Now the buyer raises a
 * quote request, every verified vendor in the organisation is invited, and
 * each reply is written into that vendor's own catalog. The buyer re-runs the
 * workflow and the agent picks the new prices up through the ordinary catalog
 * path.
 *
 * THE AGENT IS NOT INVOLVED IN ANY OF THIS. It never contacts a supplier; it
 * only ever reads the catalog, which is what keeps a run fast, deterministic
 * and replayable. Five consequences shape every line of copy below.
 *
 *  - `publish_to_catalog` is the whole ballgame. `respond_to_quote_request`
 *    only calls `CatalogRepository.upsert_by_sku` when that flag is set, and
 *    the agent's `find_offers` reads published, visible rows and nothing else.
 *    An unpublished reply is recorded for the buyer to read by hand and is
 *    invisible to the scorer — so the switch defaults on and says why.
 *  - The quantity a vendor states becomes the STOCK on the published row, and
 *    `find_offers` filters `stock >= quantity` requested. Quoting short, or
 *    leaving the quantity blank, publishes a row the agent will skip. That is
 *    a footgun the form refuses to let a vendor walk into silently.
 *  - Over budget is an exclusion, not a penalty: `is_within_budget` is
 *    `total <= budget`, and a quote above it is dropped before it is ever
 *    scored. Partial coverage is excluded from winning alone as well. Both are
 *    surfaced live against the running total rather than discovered later.
 *  - Delivery and warranty are scored PER LINE, because `_catalog_values`
 *    writes the per-line figures onto the catalog row and `catalog_query`
 *    builds its offer from that row. The response-level "overall" pair is
 *    recorded on the reply for the buyer to read and never reaches the agent,
 *    so the form must not let a vendor believe otherwise. A blank term still
 *    publishes; `build_components` just scores it at a neutral placeholder.
 *  - Publishing is not reversible from here. `respond_to_quote_request` only
 *    ever writes to the catalog, so turning the switch off on an UPDATE leaves
 *    the previously published rows standing — the agent goes on reading the
 *    old prices. That is a different outcome from "invisible", and it is said.
 *
 * Claymorphic throughout, like the rest of the portal: opaque and extruded, so
 * the supplier's half of the marketplace never blurs into the buyer's glass.
 *
 * Each request carries ONLY this vendor's own row as `my_response` — a
 * supplier never sees a competitor's price, which is exactly why responses are
 * per-vendor rows rather than one shared document.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  Boxes,
  CheckCircle2,
  Clock,
  Inbox,
  Lock,
  MessageSquareQuote,
  Pencil,
  RefreshCw,
  Send,
  Wallet,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ChipGroup,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  StatusPill,
  Switch,
  Textarea,
  cn,
  useToast,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  dateTime,
  money,
  number as formatNumber,
  parseDate,
  relativeTime,
  type Tone,
} from "@/lib/format";
import type {
  QuoteRequestStatus,
  QuoteResponse,
  QuoteResponseLine,
  QuoteResponseResult,
  QuoteResponseStatus,
  RequestItem,
  VendorQuoteRequest,
} from "@/lib/types";

/* ==========================================================================
   Constants
   ========================================================================== */

/** The clay-recess treatment applied over the Input primitive's glass defaults. */
const CLAY_FIELD =
  "border-transparent bg-[#ddedf4] backdrop-blur-none text-[#2e3e47] " +
  "shadow-[inset_0_2px_5px_rgba(68,127,152,0.22),inset_0_-1px_0_rgba(255,255,255,0.7)] " +
  "placeholder:text-[#95aab5] focus:border-transparent focus:bg-[#e4eff5]";

/**
 * The rejected state, spelled out rather than delegated to `Input`'s own
 * `invalid` prop: that prop renders *before* `className`, so `CLAY_FIELD`
 * would win the merge and swallow it.
 */
const INVALID_FIELD =
  "border-[#fecdca] bg-[#fef3f2] shadow-[inset_0_2px_5px_rgba(180,35,24,0.16)] " +
  "focus:border-[#fecdca] focus:bg-[#fff5f4]";

const REQUEST_STATUS_LABEL: Record<QuoteRequestStatus, string> = {
  open: "Open for replies",
  closed: "Closed by the buyer",
  cancelled: "Withdrawn",
  expired: "Deadline passed",
};

const REQUEST_STATUS_TONE: Record<QuoteRequestStatus, Tone> = {
  open: "brand",
  closed: "muted",
  cancelled: "muted",
  expired: "warning",
};

const RESPONSE_STATUS_LABEL: Record<QuoteResponseStatus, string> = {
  invited: "Awaiting your reply",
  responded: "Quote sent",
  declined: "You declined",
};

const RESPONSE_STATUS_TONE: Record<QuoteResponseStatus, Tone> = {
  invited: "warning",
  responded: "positive",
  declined: "neutral",
};

/** Why a request stopped taking replies, in the vendor's terms. */
const CLOSED_EXPLANATION: Record<QuoteRequestStatus, string> = {
  open: "",
  closed:
    "The buyer stopped taking replies. Whatever was published before it closed is still in your catalog and can still be quoted on the next run.",
  cancelled:
    "The buyer withdrew this request. Nothing further is expected of you.",
  expired:
    "The deadline passed before this was answered. The request expired on its own — the buyer did not turn you down.",
};

type Filter = "open" | "all";

const FILTER_OPTIONS: { value: Filter; label: string }[] = [
  { value: "open", label: "Open invitations" },
  { value: "all", label: "Include closed" },
];

/* ==========================================================================
   Small helpers
   ========================================================================== */
function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** Hours until a deadline. Negative once it has passed. */
function hoursUntil(iso: string | null): number | null {
  const date = parseDate(iso);
  if (!date) return null;
  return (date.getTime() - Date.now()) / 3_600_000;
}

/**
 * "6 hours left".
 *
 * `relativeTime` cannot serve here: it treats every future instant as
 * "just now", because its first branch tests a signed number of seconds
 * against 45. A deadline needs the other direction.
 */
function countdown(hours: number): string {
  if (hours <= 0) return "Deadline passed";
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${formatNumber(minutes)} ${plural(minutes, "minute", "minutes")} left`;
  }
  if (hours < 24) {
    const whole = Math.max(1, Math.round(hours));
    return `${formatNumber(whole)} ${plural(whole, "hour", "hours")} left`;
  }
  const days = Math.floor(hours / 24);
  return `${formatNumber(days)} ${plural(days, "day", "days")} left`;
}

/** A non-negative amount, or null when the text is not one. */
function toAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** A whole count. `min` is 1 for a quantity, 0 for a lead time. */
function toCount(raw: string, min: number): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
    return null;
  }
  return parsed;
}

/* ==========================================================================
   Presentational pieces
   ========================================================================== */
function Recess({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("clay-recess rounded-[20px] px-4 py-3", className)}>
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
        {label}
      </p>
      <div className="mt-1 text-[12.5px] leading-relaxed text-[#4a5c66]">
        {children}
      </div>
    </div>
  );
}

/** The deadline, with the urgency it deserves and never more. */
function Deadline({ request }: { request: VendorQuoteRequest }) {
  const hours = hoursUntil(request.closes_at);
  const live = request.status === "open" && hours !== null && hours > 0;
  const urgent = live && hours !== null && hours < 24;

  if (request.closes_at === null) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[#7e8c94]">
        <Clock className="size-3.5 shrink-0" aria-hidden />
        No deadline was set on this request.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[14px] px-3 py-2 text-[12px] font-semibold",
        urgent
          ? "bg-[#fffaeb] text-[#b54708]"
          : live
            ? "bg-[#e9f3f8] text-[#38677b]"
            : "bg-[#eef4f7] text-[#7e8c94]",
      )}
    >
      <Clock className="size-3.5 shrink-0" aria-hidden />
      <span>{live && hours !== null ? countdown(hours) : "Closed to replies"}</span>
      <span className="font-medium opacity-80">
        {live ? "Closes" : "Deadline was"} {dateTime(request.closes_at)}
      </span>
    </div>
  );
}

/**
 * The requested items.
 *
 * When this vendor has already replied, its own prices are folded into the
 * same table rather than repeated in a second one — a supplier reading its
 * own quote wants it beside what was asked for, not below it.
 */
function ItemsTable({
  items,
  currency,
  quoted,
}: {
  items: RequestItem[];
  currency: string;
  quoted: Map<string, QuoteResponseLine> | null;
}) {
  // A line quoted short is not a smaller win, it is no win at all: the
  // quantity became the stock on the published row, and `find_offers` filters
  // `stock >= quantity` requested. Worth saying after the fact, not only in
  // the form.
  const shortLines = quoted
    ? items.filter((item) => {
        const line = quoted.get(item.name);
        return Boolean(
          line &&
            line.available &&
            line.quantity != null &&
            line.quantity < item.quantity,
        );
      }).length
    : 0;

  if (items.length === 0) {
    return (
      <p className="clay-recess rounded-[20px] px-4 py-3 text-[12px] leading-relaxed text-[#5f7280]">
        The buyer&apos;s request did not list any items, so there is nothing
        here to price. Declining still tells them where they stand.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table
          className="w-full border-collapse text-left"
          style={{ minWidth: quoted ? 620 : 460 }}
        >
          <thead>
            <tr>
              <th className="border-b border-[#cfe0e8] pb-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                Item
              </th>
              <th className="border-b border-[#cfe0e8] pb-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                Quantity
              </th>
              <th className="border-b border-[#cfe0e8] pb-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                Specification
              </th>
              {quoted && (
                <>
                  <th className="border-b border-[#cfe0e8] pb-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                    Your unit price
                  </th>
                  <th className="border-b border-[#cfe0e8] pb-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                    Line total
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => {
              const line = quoted?.get(item.name) ?? null;
              return (
                <tr key={`${item.name}-${index}`}>
                  <td className="border-b border-[#e7eff3] py-3 pr-4 align-top">
                    <p className="text-[12.5px] font-semibold text-[#2e3e47]">
                      {item.name}
                    </p>
                    {item.category_hint && (
                      <p className="mt-0.5 text-[11px] text-[#7e8c94]">
                        Category hint: {item.category_hint}
                      </p>
                    )}
                    {line && line.available && line.title && (
                      <p className="mt-0.5 text-[11px] text-[#5f7280]">
                        You offered {line.title}
                        {line.sku ? ` · ${line.sku}` : ""}
                      </p>
                    )}
                  </td>
                  <td className="tnum border-b border-[#e7eff3] py-3 pr-4 text-right align-top text-[12.5px] text-[#4a5c66]">
                    {formatNumber(item.quantity)}
                    {item.unit ? (
                      <span className="text-[#7e8c94]"> {item.unit}</span>
                    ) : null}
                    {/* Without this the line total cannot be reconciled: it is
                        priced on the units QUOTED, not the units asked for. */}
                    {line &&
                    line.available &&
                    line.quantity != null &&
                    line.quantity !== item.quantity ? (
                      <span
                        className={cn(
                          "block text-[11px] font-medium",
                          line.quantity < item.quantity
                            ? "text-[#b54708]"
                            : "text-[#7e8c94]",
                        )}
                      >
                        you quoted {formatNumber(line.quantity)}
                      </span>
                    ) : null}
                  </td>
                  <td className="border-b border-[#e7eff3] py-3 pr-4 align-top text-[12px] leading-relaxed text-[#5f7280]">
                    {item.specification ?? (
                      <span className="text-[#9db0ba]">Not specified</span>
                    )}
                  </td>
                  {quoted && (
                    <>
                      <td className="tnum border-b border-[#e7eff3] py-3 pr-4 text-right align-top text-[12.5px] text-[#4a5c66]">
                        {line && line.available && line.unit_price != null ? (
                          money(line.unit_price, currency)
                        ) : (
                          <span className="text-[#9db0ba]">Not offered</span>
                        )}
                      </td>
                      <td className="tnum border-b border-[#e7eff3] py-3 text-right align-top text-[12.5px] font-semibold text-[#2e3e47]">
                        {line && line.available && line.line_total != null ? (
                          money(line.line_total, currency)
                        ) : (
                          <span className="font-normal text-[#9db0ba]">—</span>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {shortLines > 0 && (
        <p className="text-[11.5px] leading-relaxed text-[#b54708]">
          {formatNumber(shortLines)}{" "}
          {plural(shortLines, "line quotes", "lines quote")} fewer units than
          were asked for. The quantity you state becomes the stock on the
          published row, and the agent skips a row holding less stock than the
          request needs.
        </p>
      )}
    </div>
  );
}

/** What was sent, and — the part that decides everything — whether it is live. */
function ResponseSummary({
  response,
  currency,
}: {
  response: QuoteResponse;
  currency: string;
}) {
  const quotedCurrency = response.currency ?? currency;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="clay-recess rounded-[18px] px-4 py-3">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            Your total
          </p>
          <p className="tnum mt-1 text-[20px] font-bold leading-none tracking-[-0.03em] text-[#2e3e47]">
            {money(response.total_amount, quotedCurrency)}
          </p>
        </div>
        <div className="clay-recess rounded-[18px] px-4 py-3">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            Delivery
          </p>
          <p className="tnum mt-1 text-[20px] font-bold leading-none tracking-[-0.03em] text-[#2e3e47]">
            {response.delivery_days === null
              ? "—"
              : `${formatNumber(response.delivery_days)} ${plural(response.delivery_days, "day", "days")}`}
          </p>
        </div>
        <div className="clay-recess rounded-[18px] px-4 py-3">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            Warranty
          </p>
          <p className="tnum mt-1 text-[20px] font-bold leading-none tracking-[-0.03em] text-[#2e3e47]">
            {response.warranty_months === null
              ? "—"
              : `${formatNumber(response.warranty_months)} ${plural(response.warranty_months, "month", "months")}`}
          </p>
        </div>
      </div>

      {/* These two figures live on the reply, for the buyer to read. What is
          SCORED is the delivery and warranty on each published catalog row —
          `catalog_query` builds its offer from the row, never from here. */}
      <p className="text-[11.5px] leading-relaxed text-[#7e8c94]">
        Delivery and warranty above are the summary figures on your reply, for
        the buyer to read. The agent scores the terms carried by each published
        catalog row.
      </p>

      {response.note && (
        <Recess label="The note you sent">{response.note}</Recess>
      )}

      {response.published_to_catalog ? (
        <Alert
          tone="positive"
          icon={<CheckCircle2 className="size-4" />}
          title="Published to your catalog — the agent can read it"
        >
          Your quoted prices were written into your catalog as published,
          visible rows. When the buyer re-runs the workflow, the agent finds
          them on the ordinary catalog path and scores them against everyone
          else&apos;s. Nothing more is required of you.
        </Alert>
      ) : (
        <Alert
          tone="warning"
          title="Recorded, but invisible to the agent"
        >
          This reply was saved without publishing to your catalog. The agent
          reads the catalog and nothing else, so it cannot be quoted against —
          the buyer has to find it and read it by hand. Update your quote with
          publishing switched on to put these prices where the agent will look.
        </Alert>
      )}

      <p className="text-[11.5px] text-[#7e8c94]">
        Sent {relativeTime(response.responded_at)} · The backend updates this
        same reply rather than adding a second one, so an update is a
        correction, not another quote.
      </p>
    </div>
  );
}

/* ==========================================================================
   One request
   ========================================================================== */
function RequestCard({
  request,
  onQuote,
  onDecline,
}: {
  request: VendorQuoteRequest;
  onQuote: () => void;
  onDecline: () => void;
}) {
  const mine = request.my_response;
  const hours = hoursUntil(request.closes_at);
  // The backend expires overdue requests when they are read, so `status` is
  // authoritative — but a deadline that passed while this page sat open is
  // still a closed door, and offering a button that will 409 is worse than
  // saying so.
  const answerable =
    request.status === "open" && (hours === null || hours > 0);
  // `lines` must hold at least one entry and one available line, so a request
  // that carries no items cannot be quoted at all — the form would 422.
  const quotable = answerable && request.items.length > 0;

  const quoted =
    mine.status === "responded"
      ? new Map(
          mine.lines.map(
            (line): [string, QuoteResponseLine] => [
              line.request_item_name,
              line,
            ],
          ),
        )
      : null;

  const quotedLineCount = mine.lines.filter((line) => line.available).length;

  return (
    <Card variant="clay" padded={false} className="animate-fade-up self-start">
      <div className="space-y-4 p-5 sm:p-6">
        {/* -- Identity ---------------------------------------------------- */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[#7e8c94]">
              Quote request
            </p>
            <h2 className="mt-1 text-[18px] font-bold leading-tight tracking-[-0.02em] text-[#2e3e47]">
              {request.workflow_title ?? "An unnamed request"}
            </h2>
            <p className="mt-1 text-[11.5px] text-[#7e8c94]">
              You were invited {relativeTime(mine.invited_at)}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <StatusPill
              label={RESPONSE_STATUS_LABEL[mine.status]}
              tone={RESPONSE_STATUS_TONE[mine.status]}
            />
            <StatusPill
              label={REQUEST_STATUS_LABEL[request.status]}
              tone={REQUEST_STATUS_TONE[request.status]}
              dot={false}
            />
          </div>
        </div>

        <Deadline request={request} />

        {/* -- Why you are being asked ------------------------------------- */}
        {request.reason && (
          <Recess label="What the buyer's agent could not do">
            <p className="italic text-[#2e3e47]">{request.reason}</p>
            <p className="mt-1.5 text-[11.5px] text-[#5f7280]">
              The workflow stopped there. Your reply is what lets it start
              again.
            </p>
          </Recess>
        )}

        {request.note && (
          <Recess label="From the buyer">{request.note}</Recess>
        )}

        {/* -- The ceiling -------------------------------------------------- */}
        <div className="clay-recess flex flex-wrap items-center justify-between gap-3 rounded-[20px] px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-[12px] bg-[#f2f7fa] text-[#38677b]">
              <Wallet className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                The buyer&apos;s ceiling
              </p>
              <p className="tnum text-[15px] font-bold leading-tight text-[#2e3e47]">
                {request.budget === null
                  ? "None stated"
                  : money(request.budget, request.currency)}
              </p>
            </div>
          </div>
          <p className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-[#5f7280] sm:text-right">
            {request.budget === null
              ? "No budget was recorded, so nothing will be excluded on price alone."
              : "A quote above this is excluded from the comparison before it is scored."}
          </p>
        </div>

        {/* -- What was asked for ------------------------------------------- */}
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            What they need
          </p>
          <ItemsTable
            items={request.items}
            currency={request.currency}
            quoted={quoted}
          />
        </div>

        {/* -- Your standing ------------------------------------------------ */}
        {mine.status === "responded" && (
          <ResponseSummary response={mine} currency={request.currency} />
        )}

        {mine.status === "declined" && (
          <Recess label="You declined this">
            {mine.decline_reason ? (
              <p className="italic text-[#2e3e47]">{mine.decline_reason}</p>
            ) : (
              <p className="text-[#5f7280]">
                No reason was recorded — the buyer only knows that you cannot
                supply this.
              </p>
            )}
            <p className="mt-1.5 text-[11.5px] text-[#5f7280]">
              Declining is not final. While the request is open you can still
              quote, and quoting replaces the decline.
            </p>
          </Recess>
        )}

        {mine.status === "invited" && answerable && (
          <p className="text-[12.5px] leading-relaxed text-[#5f7280]">
            You have not answered yet. From the buyer&apos;s side that looks
            exactly like a supplier who has not looked — a decline at least
            tells them where they stand.
          </p>
        )}

        {/* -- Actions ------------------------------------------------------ */}
        <div className="flex flex-wrap items-center gap-2 border-t border-white/70 pt-4">
          {mine.status === "responded" ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Pencil className="size-3.5" />}
              disabled={!quotable}
              onClick={onQuote}
            >
              Update my quote
            </Button>
          ) : (
            <Button
              size="sm"
              icon={<Send className="size-3.5" />}
              disabled={!quotable}
              onClick={onQuote}
            >
              {mine.status === "declined" ? "Quote after all" : "Quote for this"}
            </Button>
          )}

          {mine.status === "invited" && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Ban className="size-3.5" />}
              disabled={!answerable}
              onClick={onDecline}
            >
              Decline
            </Button>
          )}

          {mine.status === "responded" && quotedLineCount > 0 && (
            <p className="tnum text-[11.5px] text-[#7e8c94]">
              {formatNumber(quotedLineCount)}{" "}
              {plural(quotedLineCount, "line", "lines")} quoted of{" "}
              {formatNumber(request.items.length)}
            </p>
          )}
        </div>

        {!answerable && (
          <p className="text-[11.5px] leading-relaxed text-[#b54708]">
            This request is no longer taking replies
            {request.closed_at ? ` — closed ${dateTime(request.closed_at)}` : ""}
            . {CLOSED_EXPLANATION[request.status] || CLOSED_EXPLANATION.expired}
          </p>
        )}
      </div>
    </Card>
  );
}

/* ==========================================================================
   The quote form
   ========================================================================== */
interface LineDraft {
  requestItemName: string;
  requestedQuantity: number;
  unit: string | null;
  specification: string | null;
  available: boolean;
  sku: string;
  title: string;
  unitPrice: string;
  quantity: string;
  deliveryDays: string;
  warrantyMonths: string;
}

interface LineErrors {
  sku?: string;
  title?: string;
  unitPrice?: string;
  quantity?: string;
  deliveryDays?: string;
  warrantyMonths?: string;
}

function buildDrafts(request: VendorQuoteRequest): LineDraft[] {
  const previous = new Map<string, QuoteResponseLine>(
    request.my_response.status === "responded"
      ? request.my_response.lines.map(
          (line): [string, QuoteResponseLine] => [line.request_item_name, line],
        )
      : [],
  );

  return request.items.map((item) => {
    const before = previous.get(item.name);
    return {
      requestItemName: item.name,
      requestedQuantity: item.quantity,
      unit: item.unit ?? null,
      specification: item.specification ?? null,
      available: before ? before.available : true,
      sku: before?.sku ?? "",
      title: before?.title ?? "",
      unitPrice: before?.unit_price != null ? String(before.unit_price) : "",
      quantity:
        before?.quantity != null
          ? String(before.quantity)
          : String(item.quantity),
      deliveryDays:
        before?.delivery_days != null ? String(before.delivery_days) : "",
      warrantyMonths:
        before?.warranty_months != null ? String(before.warranty_months) : "",
    };
  });
}

function QuoteModal({
  request,
  onClose,
}: {
  request: VendorQuoteRequest;
  onClose: () => void;
}) {
  const fieldId = useId();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isUpdate = request.my_response.status === "responded";
  /**
   * Whether prices from an earlier reply are ALREADY live in the catalog.
   *
   * This is the difference between "the agent cannot see this" and "the agent
   * will go on reading my old prices". `respond_to_quote_request` only writes
   * to the catalog when the flag is set — it never withdraws what it wrote —
   * so turning publishing off on an update leaves the previous rows standing.
   */
  const wasPublished = isUpdate && request.my_response.published_to_catalog;

  const [drafts, setDrafts] = useState<LineDraft[]>(() => buildDrafts(request));
  const [overallDelivery, setOverallDelivery] = useState(
    request.my_response.delivery_days != null && isUpdate
      ? String(request.my_response.delivery_days)
      : "",
  );
  const [overallWarranty, setOverallWarranty] = useState(
    request.my_response.warranty_months != null && isUpdate
      ? String(request.my_response.warranty_months)
      : "",
  );
  const [note, setNote] = useState(
    isUpdate ? (request.my_response.note ?? "") : "",
  );
  const [publish, setPublish] = useState(true);

  const [errors, setErrors] = useState<Record<number, LineErrors>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [overallErrors, setOverallErrors] = useState<{
    delivery?: string;
    warranty?: string;
  }>({});
  const [result, setResult] = useState<QuoteResponseResult | null>(null);

  const setLine = (index: number, patch: Partial<LineDraft>) => {
    setDrafts((previous) =>
      previous.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
    setErrors((previous) => {
      if (!previous[index]) return previous;
      const next = { ...previous };
      delete next[index];
      return next;
    });
    setFormError(null);
  };

  /* -- Running total ----------------------------------------------------- */
  const availableCount = drafts.filter((line) => line.available).length;

  const total = useMemo(
    () =>
      drafts.reduce((sum, line) => {
        if (!line.available) return sum;
        const price = toAmount(line.unitPrice);
        const quantity = toCount(line.quantity, 1);
        if (price === null || quantity === null) return sum;
        return sum + price * quantity;
      }, 0),
    [drafts],
  );

  const overBudget = request.budget !== null && total > request.budget;
  const headroom = request.budget === null ? null : request.budget - total;
  const shortQuantity = drafts.some((line) => {
    if (!line.available) return false;
    const quantity = toCount(line.quantity, 1);
    return quantity !== null && quantity < line.requestedQuantity;
  });
  /**
   * A line with no lead time or warranty still publishes and is still quoted —
   * but the catalog row carries a null, and `build_components` fills a null
   * with a NEUTRAL placeholder rather than the vendor's real terms, which also
   * drops the data-confidence figure the buyer is shown.
   */
  const missingTerms = drafts.some(
    (line) =>
      line.available &&
      (line.deliveryDays.trim() === "" || line.warrantyMonths.trim() === ""),
  );

  /* -- Validation --------------------------------------------------------- */
  const validate = (): boolean => {
    const nextErrors: Record<number, LineErrors> = {};

    drafts.forEach((line, index) => {
      if (!line.available) return;
      const lineErrors: LineErrors = {};

      if (!line.sku.trim()) {
        lineErrors.sku = "Required — this becomes the catalog row's SKU.";
      } else if (line.sku.trim().length > 64) {
        lineErrors.sku = "64 characters at most.";
      }

      if (!line.title.trim()) {
        lineErrors.title = "Required — this is what the agent matches on.";
      } else if (line.title.trim().length > 200) {
        lineErrors.title = "200 characters at most.";
      }

      if (toAmount(line.unitPrice) === null) {
        lineErrors.unitPrice = "Enter a price, or mark this line unavailable.";
      }

      if (toCount(line.quantity, 1) === null) {
        lineErrors.quantity =
          "Enter a whole number of units, at least one — it becomes the stock.";
      }

      if (line.deliveryDays.trim() && toCount(line.deliveryDays, 0) === null) {
        lineErrors.deliveryDays = "Whole days, or leave it blank.";
      }

      if (
        line.warrantyMonths.trim() &&
        toCount(line.warrantyMonths, 0) === null
      ) {
        lineErrors.warrantyMonths = "Whole months, or leave it blank.";
      }

      if (Object.keys(lineErrors).length > 0) nextErrors[index] = lineErrors;
    });

    const nextOverall: { delivery?: string; warranty?: string } = {};
    if (overallDelivery.trim() && toCount(overallDelivery, 0) === null) {
      nextOverall.delivery = "Whole days, or leave it blank.";
    }
    if (overallWarranty.trim() && toCount(overallWarranty, 0) === null) {
      nextOverall.warranty = "Whole months, or leave it blank.";
    }

    setErrors(nextErrors);
    setOverallErrors(nextOverall);

    if (availableCount === 0) {
      setFormError(
        "Nothing is marked available. If you cannot supply any of this, decline the request instead — that is a real answer, and far more use to the buyer than silence.",
      );
      return false;
    }
    if (
      Object.keys(nextErrors).length > 0 ||
      Object.keys(nextOverall).length > 0
    ) {
      setFormError(
        "Some lines are incomplete. A line you are offering needs a SKU, a title and a price — those three become the catalog row the agent reads.",
      );
      return false;
    }

    setFormError(null);
    return true;
  };

  /* -- Submit ------------------------------------------------------------- */
  const mutation = useMutation({
    mutationFn: (body: {
      lines: QuoteResponseLine[];
      note?: string | null;
      delivery_days?: number | null;
      warranty_months?: number | null;
      publish_to_catalog?: boolean;
    }) => api.respondToQuoteRequest(request.id, body),
    onSuccess: (payload) => {
      void queryClient.invalidateQueries({
        queryKey: ["vendor", "quote-requests"],
      });
      void queryClient.invalidateQueries({ queryKey: ["catalog", "me"] });
      setResult(payload);
      toast(
        payload.detail,
        payload.catalog_items_published > 0 ? "positive" : "warning",
      );
    },
    onError: (failure: unknown) => {
      setFormError(
        failure instanceof Error
          ? failure.message
          : "Could not send this quote.",
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) return;

    const lines: QuoteResponseLine[] = drafts.map((line) => {
      if (!line.available) {
        return { request_item_name: line.requestItemName, available: false };
      }
      return {
        request_item_name: line.requestItemName,
        available: true,
        sku: line.sku.trim(),
        title: line.title.trim(),
        unit_price: toAmount(line.unitPrice),
        quantity: toCount(line.quantity, 1),
        delivery_days: line.deliveryDays.trim()
          ? toCount(line.deliveryDays, 0)
          : null,
        warranty_months: line.warrantyMonths.trim()
          ? toCount(line.warrantyMonths, 0)
          : null,
      };
    });

    mutation.mutate({
      lines,
      note: note.trim() || null,
      delivery_days: overallDelivery.trim()
        ? toCount(overallDelivery, 0)
        : null,
      warranty_months: overallWarranty.trim()
        ? toCount(overallWarranty, 0)
        : null,
      publish_to_catalog: publish,
    });
  };

  /* -- The sent confirmation ---------------------------------------------- */
  if (result) {
    const published = result.catalog_items_published;
    return (
      <Modal
        open
        onClose={onClose}
        width={620}
        title={published > 0 ? "Your quote is live" : "Your quote was recorded"}
        description={
          published > 0
            ? "The prices below are now rows in your catalog, exactly like the rest of your listings."
            : "Nothing was written to your catalog, which changes what happens next."
        }
        footer={
          <Button onClick={onClose} icon={<CheckCircle2 className="size-4" />}>
            Done
          </Button>
        }
      >
        <div className="space-y-4 pb-4">
          <div className="clay-recess flex items-center gap-4 rounded-[20px] px-4 py-4">
            <p
              className={cn(
                "tnum text-[36px] font-bold leading-none tracking-[-0.03em]",
                published > 0 ? "text-[#067647]" : "text-[#b54708]",
              )}
            >
              {formatNumber(published)}
            </p>
            <p className="text-[12.5px] leading-relaxed text-[#4a5c66]">
              catalog {plural(published, "row", "rows")}{" "}
              {published === 1 ? "was" : "were"} published from this reply.
            </p>
          </div>

          {/* The backend words this carefully; it is quoted, not paraphrased. */}
          <Alert
            tone={published > 0 ? "positive" : "warning"}
            title="What the API reported"
          >
            {result.detail}
          </Alert>

          <p className="text-[12px] leading-relaxed text-[#5f7280]">
            {published > 0
              ? "Nothing further is required of you. When the buyer re-runs the workflow, the agent reads your catalog on its ordinary path — it never contacts you — and scores these prices against every other supplier's."
              : wasPublished
                ? "The prices you published earlier are still live rows in your catalog, so the agent will go on reading those rather than this correction. Send the quote again with publishing switched on to replace them."
                : "The agent reads the catalog and nothing else, so this reply cannot be quoted against. Update the quote with publishing switched on whenever you want it considered."}
          </p>
        </div>
      </Modal>
    );
  }

  /* -- The form ------------------------------------------------------------ */
  return (
    <Modal
      open
      onClose={onClose}
      width={760}
      title={isUpdate ? "Update your quote" : "Quote for this request"}
      description={
        isUpdate
          ? "This replaces the reply you already sent — the backend updates the same row rather than adding a second quote."
          : "One line per thing they asked for. Price what you can supply and mark the rest unavailable."
      }
      footer={
        <>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={`${fieldId}-form`}
            loading={mutation.isPending}
            icon={<Send className="size-4" />}
          >
            {isUpdate ? "Send the correction" : "Send my quote"}
          </Button>
        </>
      }
    >
      <form id={`${fieldId}-form`} onSubmit={submit} className="space-y-5 pb-4">
        {/* -- Lines --------------------------------------------------------- */}
        <div className="space-y-3">
          {drafts.map((line, index) => {
            const lineErrors = errors[index] ?? {};
            const price = toAmount(line.unitPrice);
            const quantity = toCount(line.quantity, 1);
            const lineTotal =
              price !== null && quantity !== null ? price * quantity : null;

            return (
              <div
                key={`${line.requestItemName}-${index}`}
                className="clay-recess rounded-[20px] p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-[#2e3e47]">
                      {line.requestItemName}
                    </p>
                    <p className="tnum mt-0.5 text-[11.5px] text-[#5f7280]">
                      {formatNumber(line.requestedQuantity)}
                      {line.unit ? ` ${line.unit}` : ""} requested
                      {line.specification ? ` · ${line.specification}` : ""}
                    </p>
                  </div>
                  {lineTotal !== null && line.available && (
                    <p className="tnum shrink-0 text-[13px] font-bold text-[#2e3e47]">
                      {money(lineTotal, request.currency)}
                    </p>
                  )}
                </div>

                <Checkbox
                  className="mt-3"
                  checked={line.available}
                  onChange={(next) => setLine(index, { available: next })}
                  label="I can supply this"
                  hint={
                    line.available
                      ? undefined
                      : "Left unavailable. Your quote is still sent, but it will not cover this line."
                  }
                />

                {line.available && (
                  <div className="mt-4 space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field
                        label="SKU"
                        required
                        htmlFor={`${fieldId}-sku-${index}`}
                        error={lineErrors.sku}
                        hint={
                          lineErrors.sku
                            ? undefined
                            : "Reusing an existing SKU updates that catalog row."
                        }
                      >
                        <Input
                          id={`${fieldId}-sku-${index}`}
                          value={line.sku}
                          maxLength={64}
                          aria-invalid={Boolean(lineErrors.sku)}
                          onChange={(event) =>
                            setLine(index, { sku: event.target.value })
                          }
                          placeholder="RFQ-LAP-5550"
                          className={cn(
                            CLAY_FIELD,
                            lineErrors.sku && INVALID_FIELD,
                          )}
                        />
                      </Field>

                      <Field
                        label="What you would supply"
                        required
                        htmlFor={`${fieldId}-title-${index}`}
                        error={lineErrors.title}
                        hint={
                          lineErrors.title
                            ? undefined
                            : "The product name a buyer would recognise."
                        }
                      >
                        <Input
                          id={`${fieldId}-title-${index}`}
                          value={line.title}
                          maxLength={200}
                          aria-invalid={Boolean(lineErrors.title)}
                          onChange={(event) =>
                            setLine(index, { title: event.target.value })
                          }
                          placeholder={`Your ${line.requestItemName}`}
                          className={cn(
                            CLAY_FIELD,
                            lineErrors.title && INVALID_FIELD,
                          )}
                        />
                      </Field>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field
                        label={`Unit price (${request.currency})`}
                        required
                        htmlFor={`${fieldId}-price-${index}`}
                        error={lineErrors.unitPrice}
                      >
                        <Input
                          id={`${fieldId}-price-${index}`}
                          inputMode="decimal"
                          value={line.unitPrice}
                          aria-invalid={Boolean(lineErrors.unitPrice)}
                          onChange={(event) =>
                            setLine(index, { unitPrice: event.target.value })
                          }
                          placeholder="165000"
                          className={cn(
                            CLAY_FIELD,
                            "tnum",
                            lineErrors.unitPrice && INVALID_FIELD,
                          )}
                        />
                      </Field>

                      <Field
                        label="Units you can supply"
                        required
                        htmlFor={`${fieldId}-qty-${index}`}
                        error={lineErrors.quantity}
                        hint={
                          lineErrors.quantity
                            ? undefined
                            : "Becomes the stock on the published row."
                        }
                      >
                        <Input
                          id={`${fieldId}-qty-${index}`}
                          inputMode="numeric"
                          value={line.quantity}
                          aria-invalid={Boolean(lineErrors.quantity)}
                          onChange={(event) =>
                            setLine(index, { quantity: event.target.value })
                          }
                          className={cn(
                            CLAY_FIELD,
                            "tnum",
                            lineErrors.quantity && INVALID_FIELD,
                          )}
                        />
                      </Field>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field
                        label="Delivery (days)"
                        htmlFor={`${fieldId}-delivery-${index}`}
                        error={lineErrors.deliveryDays}
                        hint={
                          lineErrors.deliveryDays
                            ? undefined
                            : "Goes onto the published row — this is the lead time the agent scores."
                        }
                      >
                        <Input
                          id={`${fieldId}-delivery-${index}`}
                          inputMode="numeric"
                          value={line.deliveryDays}
                          aria-invalid={Boolean(lineErrors.deliveryDays)}
                          onChange={(event) =>
                            setLine(index, { deliveryDays: event.target.value })
                          }
                          placeholder="Optional"
                          className={cn(
                            CLAY_FIELD,
                            "tnum",
                            lineErrors.deliveryDays && INVALID_FIELD,
                          )}
                        />
                      </Field>
                      <Field
                        label="Warranty (months)"
                        htmlFor={`${fieldId}-warranty-${index}`}
                        error={lineErrors.warrantyMonths}
                        hint={
                          lineErrors.warrantyMonths
                            ? undefined
                            : "Goes onto the published row — this is the warranty the agent scores."
                        }
                      >
                        <Input
                          id={`${fieldId}-warranty-${index}`}
                          inputMode="numeric"
                          value={line.warrantyMonths}
                          aria-invalid={Boolean(lineErrors.warrantyMonths)}
                          onChange={(event) =>
                            setLine(index, {
                              warrantyMonths: event.target.value,
                            })
                          }
                          placeholder="Optional"
                          className={cn(
                            CLAY_FIELD,
                            "tnum",
                            lineErrors.warrantyMonths && INVALID_FIELD,
                          )}
                        />
                      </Field>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* -- Running total against the ceiling ----------------------------- */}
        <div
          className={cn(
            "rounded-[20px] px-4 py-3.5",
            overBudget ? "bg-[#fffaeb]" : "clay-recess",
          )}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
              Your quote total
            </p>
            <p
              className={cn(
                "tnum text-[24px] font-bold leading-none tracking-[-0.03em]",
                overBudget ? "text-[#b54708]" : "text-[#2e3e47]",
              )}
            >
              {money(total, request.currency)}
            </p>
          </div>
          <p className="tnum mt-1.5 text-[11.5px] text-[#5f7280]">
            {formatNumber(availableCount)} of{" "}
            {formatNumber(drafts.length)}{" "}
            {plural(drafts.length, "line", "lines")} priced
            {request.budget !== null
              ? ` · ceiling ${money(request.budget, request.currency)}`
              : ""}
          </p>

          {request.budget !== null && (
            <p
              className={cn(
                "mt-2 text-[12px] font-medium leading-relaxed",
                overBudget ? "text-[#b54708]" : "text-[#067647]",
              )}
            >
              {overBudget
                ? `Over the buyer's ceiling by ${money(total - request.budget, request.currency)}. A quote above the budget is excluded from the comparison before it is ever scored — you can still send it, but it cannot win.`
                : headroom !== null
                  ? `Inside the ceiling, with ${money(headroom, request.currency)} to spare.`
                  : ""}
            </p>
          )}

          {availableCount > 0 && availableCount < drafts.length && (
            <p className="mt-2 text-[12px] leading-relaxed text-[#b54708]">
              You are not covering every line. A partial quote is shown to the
              buyer, but the scorer will not select it as the sole supplier —
              price the remaining{" "}
              <span className="tnum">
                {formatNumber(drafts.length - availableCount)}
              </span>{" "}
              {plural(drafts.length - availableCount, "line", "lines")} if you
              can.
            </p>
          )}

          {shortQuantity && (
            <p className="mt-2 text-[12px] leading-relaxed text-[#b54708]">
              One of your quantities is below what was asked for. The quantity
              becomes the stock on the published row, and the agent skips a row
              holding less stock than the request needs.
            </p>
          )}

          {missingTerms && (
            <p className="mt-2 text-[12px] leading-relaxed text-[#5f7280]">
              A line without a delivery or warranty is still published and
              still quoted — but the row carries no term, so the agent scores
              that criterion with a neutral placeholder instead of your real
              one, and the buyer sees a lower confidence figure beside your
              quote. Stating both is usually worth doing.
            </p>
          )}
        </div>

        {/* -- Overall terms --------------------------------------------------
            Recorded on the reply, for the BUYER to read. They are not written
            to the catalog, so they are not what the agent scores — the per-line
            figures above are. Saying otherwise would be the same mistake as
            implying an unpublished reply is visible. */}
        <div className="space-y-2">
          <p className="text-[11.5px] leading-relaxed text-[#7e8c94]">
            These two summarise your reply for the buyer to read. They are not
            written to your catalog, so they are not what the agent scores —
            the per-line terms above are.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Overall delivery (days)"
              htmlFor={`${fieldId}-overall-delivery`}
              error={overallErrors.delivery}
              hint={
                overallErrors.delivery
                  ? undefined
                  : "Optional. Left blank, it defaults to the slowest lead time you quoted — an order lands when its slowest line lands."
              }
            >
              <Input
                id={`${fieldId}-overall-delivery`}
                inputMode="numeric"
                value={overallDelivery}
                aria-invalid={Boolean(overallErrors.delivery)}
                onChange={(event) => {
                  setOverallDelivery(event.target.value);
                  setOverallErrors((previous) => ({
                    ...previous,
                    delivery: undefined,
                  }));
                }}
                placeholder="Slowest quoted line"
                className={cn(
                  CLAY_FIELD,
                  "tnum",
                  overallErrors.delivery && INVALID_FIELD,
                )}
              />
            </Field>

            <Field
              label="Overall warranty (months)"
              htmlFor={`${fieldId}-overall-warranty`}
              error={overallErrors.warranty}
              hint={
                overallErrors.warranty
                  ? undefined
                  : "Optional. Left blank, it defaults to the shortest warranty you quoted — that is the term a buyer can actually rely on."
              }
            >
              <Input
                id={`${fieldId}-overall-warranty`}
                inputMode="numeric"
                value={overallWarranty}
                aria-invalid={Boolean(overallErrors.warranty)}
                onChange={(event) => {
                  setOverallWarranty(event.target.value);
                  setOverallErrors((previous) => ({
                    ...previous,
                    warranty: undefined,
                  }));
                }}
                placeholder="Shortest quoted line"
                className={cn(
                  CLAY_FIELD,
                  "tnum",
                  overallErrors.warranty && INVALID_FIELD,
                )}
              />
            </Field>
          </div>
        </div>

        <Field
          label="Note to the buyer"
          htmlFor={`${fieldId}-note`}
          hint="Optional. Anything the prices do not say — a substitution, a condition, a lead time that depends on the order size."
        >
          <Textarea
            id={`${fieldId}-note`}
            value={note}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Price holds for 30 days. Bulk discount available above 20 units."
            className={cn(CLAY_FIELD, "min-h-[84px]")}
          />
        </Field>

        {/* -- The switch that decides whether any of this counts -------------- */}
        <div
          className={cn(
            "rounded-[20px] px-4 py-3.5",
            publish ? "clay-recess" : "bg-[#fffaeb]",
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[#2e3e47]">
                Publish these prices to my catalog
              </p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#5f7280]">
                Recommended. This is what makes the offer real.
              </p>
            </div>
            <Switch checked={publish} onChange={setPublish} />
          </div>

          <p
            className={cn(
              "mt-3 border-t pt-3 text-[12px] leading-relaxed",
              publish
                ? "border-white/70 text-[#5f7280]"
                : "border-[#fedf89] text-[#b54708]",
            )}
          >
            {publish
              ? "Each priced line is written into your catalog as a published, visible row. The agent reads the catalog and nothing else — it never contacts you — so publishing is what puts your price in front of it. The buyer re-runs their workflow and your prices are compared like any other listing."
              : "Your reply will be recorded but not written to your catalog. The agent reads the catalog and nothing else, so an unpublished reply cannot be quoted against: the buyer would have to find it and read it by hand."}
          </p>

          {/* Turning the switch off does not UNDO the last publish. The rows
              stay exactly as they were, so the agent keeps quoting the old
              prices — a materially different outcome from "invisible". */}
          {!publish && wasPublished && (
            <p className="mt-2 border-t border-[#fedf89] pt-2 text-[12px] font-medium leading-relaxed text-[#b54708]">
              The prices you published earlier are still live rows in your
              catalog. Leaving this off does not withdraw them — it leaves the
              OLD prices where the agent will read them, and this correction
              never reaches it.
            </p>
          )}
        </div>

        {formError && (
          <p className="rounded-[14px] border border-[#fecdca] bg-[#fef3f2] px-3.5 py-2.5 text-[12.5px] font-medium leading-relaxed text-[#b42318]">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  );
}

/* ==========================================================================
   Decline
   ========================================================================== */
function DeclineModal({
  request,
  onClose,
}: {
  request: VendorQuoteRequest;
  onClose: () => void;
}) {
  const fieldId = useId();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.declineQuoteRequest(request.id, reason.trim() || undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["vendor", "quote-requests"],
      });
      toast("Recorded. The buyer knows where you stand.", "neutral");
      onClose();
    },
    onError: (failure: unknown) => {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not record that decline.",
      );
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      width={500}
      title="Decline this request"
      description="A clear no is worth sending."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            loading={mutation.isPending}
            icon={<Ban className="size-4" />}
            onClick={() => mutation.mutate()}
          >
            Decline
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-4">
        <p className="clay-recess rounded-[18px] px-4 py-3 text-[12.5px] leading-relaxed text-[#4a5c66]">
          &ldquo;We cannot supply this&rdquo; is a real answer, and a buyer
          staring at silence cannot tell it apart from a supplier who has not
          looked yet. Declining costs you nothing — and while the request stays
          open you can still change your mind and quote.
        </p>

        <Field
          label="Reason"
          htmlFor={`${fieldId}-reason`}
          hint={
            <>
              Optional, and only the buyer sees it. &ldquo;Out of stock until
              March&rdquo; tells them something worth knowing.
            </>
          }
        >
          <Textarea
            id={`${fieldId}-reason`}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="We do not carry this category."
            className={cn(CLAY_FIELD, "min-h-[84px]")}
          />
        </Field>

        {error && (
          <p className="rounded-[14px] border border-[#fecdca] bg-[#fef3f2] px-3.5 py-2.5 text-[12.5px] font-medium text-[#b42318]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ==========================================================================
   Page
   ========================================================================== */
export default function VendorQuoteRequestsPage() {
  const router = useRouter();

  const [filter, setFilter] = useState<Filter>("open");
  const [quoteFor, setQuoteFor] = useState<VendorQuoteRequest | null>(null);
  const [declineFor, setDeclineFor] = useState<VendorQuoteRequest | null>(null);

  const includeClosed = filter === "all";

  const requestsQuery = useQuery({
    queryKey: ["vendor", "quote-requests", includeClosed],
    queryFn: () => api.myQuoteRequests(includeClosed),
  });

  const requests = requestsQuery.data ?? [];
  const unanswered = requests.filter(
    (request) =>
      request.status === "open" && request.my_response.status === "invited",
  ).length;

  const forbidden =
    requestsQuery.error instanceof ApiError && requestsQuery.error.isForbidden;

  const header = (
    <PageHeader
      title="Quote requests"
      description="A buyer asked for something your catalog could not answer, so they are asking you directly. Reply with a price and you are in the running for business you were never listed for."
      actions={
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw className="size-3.5" />}
          loading={requestsQuery.isFetching}
          onClick={() => void requestsQuery.refetch()}
        >
          Refresh
        </Button>
      }
    />
  );

  /* -- Not a vendor account ------------------------------------------------ */
  if (forbidden) {
    return (
      <>
        {header}
        <Card variant="clay" className="animate-fade-up max-w-2xl">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-[16px] bg-[#ddedf4] text-[#38677b] shadow-[inset_0_2px_5px_rgba(68,127,152,0.22)]">
              <Lock className="size-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-[#2e3e47]">
                This screen belongs to a supplier account
              </h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[#5f7280]">
                The API answered{" "}
                <span className="font-medium text-[#4a5c66]">
                  &ldquo;{requestsQuery.error instanceof ApiError
                    ? requestsQuery.error.message
                    : "forbidden"}
                  &rdquo;
                </span>
                . Quote requests are scoped to the vendor profile the signed-in
                identity owns — never to a vendor id sent by the client — which
                is the same guard that stops one supplier reading what a
                competitor quoted. A buyer follows the replies from the
                workflow the request was raised against.
              </p>
            </div>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      {header}

      {/* -- What this is, and why the agent is not on the phone ------------- */}
      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card variant="clay" className="animate-fade-up lg:col-span-2">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-[14px] bg-[#ddedf4] text-[#38677b] shadow-[inset_0_2px_5px_rgba(68,127,152,0.22)]">
              <MessageSquareQuote className="size-4" />
            </span>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#2e3e47]">
              Why you are being asked at all
            </h2>
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-[#5f7280]">
            A buyer&apos;s workflow searched every published catalog in the
            organisation and stopped: nothing matched what they needed, or
            nothing came in under their budget. Rather than abandon the request,
            they raised a quote request — and every verified supplier was
            invited at the same moment with the same question.{" "}
            <strong className="font-semibold text-[#2e3e47]">
              You are not shown anyone else&apos;s price, and no one is shown
              yours.
            </strong>{" "}
            Each supplier answers on its own row, which is exactly why this
            screen can exist without leaking a competitor&apos;s numbers.
          </p>
          <p className="mt-2.5 text-[12.5px] leading-relaxed text-[#5f7280]">
            Being asked is also a signal worth reading: it means the catalog
            could not answer for you. The suppliers who rarely see this screen
            are the ones whose listings are already published, priced and in
            stock.
          </p>
        </Card>

        <Card variant="clay" className="animate-fade-up">
          <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            How your reply reaches the agent
          </p>
          <div className="mt-3 space-y-2.5">
            <div className="clay-recess rounded-[18px] px-4 py-3">
              <p className="text-[12.5px] font-semibold text-[#2e3e47]">
                1 · You quote a price
              </p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#5f7280]">
                One line for each thing they asked for.
              </p>
            </div>
            <div className="clay-recess rounded-[18px] px-4 py-3">
              <p className="text-[12.5px] font-semibold text-[#2e3e47]">
                2 · It is written into your catalog
              </p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#5f7280]">
                Published and visible alongside your ordinary listings — as
                long as you leave publishing switched on.
              </p>
            </div>
            <div className="clay-recess rounded-[18px] px-4 py-3">
              <p className="text-[12.5px] font-semibold text-[#2e3e47]">
                3 · The buyer re-runs the workflow
              </p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#5f7280]">
                The agent reads the catalog, as it always does, and scores you
                against everyone else.
              </p>
            </div>
          </div>
          <p className="mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed text-[#5f7280]">
            <Boxes className="mt-px size-3.5 shrink-0 text-[#447f98]" aria-hidden />
            <span>
              The agent never contacts you. It only ever reads the catalog —
              which is why a reply you do not publish cannot be quoted against.
            </span>
          </p>
        </Card>
      </div>

      {/* -- Filter --------------------------------------------------------- */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ChipGroup options={FILTER_OPTIONS} value={filter} onChange={setFilter} />
        {requests.length > 0 && (
          <p className="tnum text-[12px] font-semibold text-[#7e8c94]">
            {formatNumber(requests.length)}{" "}
            {plural(requests.length, "request", "requests")}
            {unanswered > 0
              ? ` · ${formatNumber(unanswered)} awaiting your reply`
              : ""}
          </p>
        )}
      </div>

      {/* -- The requests --------------------------------------------------- */}
      {requestsQuery.isLoading ? (
        <Card variant="clay" className="animate-fade-up">
          <LoadingBlock rows={3} />
        </Card>
      ) : requestsQuery.error ? (
        <Card variant="clay" className="animate-fade-up">
          <ErrorState
            error={requestsQuery.error}
            onRetry={() => void requestsQuery.refetch()}
          />
        </Card>
      ) : requests.length === 0 ? (
        <Card variant="clay" className="animate-fade-up">
          {includeClosed ? (
            <EmptyState
              icon={<Inbox className="size-6" />}
              title="Nothing has been asked of you yet"
              description="No buyer has raised a quote request that includes you. That is not a bad sign: a request only happens when the catalog could not answer. Keep your listings published, priced and in stock, and the agent can quote you without anyone having to ask."
              action={
                <Button variant="secondary" onClick={() => router.push("/portal")}>
                  Go to my catalog
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Inbox className="size-6" />}
              title="No open invitations"
              description="Nothing is waiting on you right now. Past requests — answered, declined or expired — are still here if you switch the filter."
              action={
                <Button variant="secondary" onClick={() => setFilter("all")}>
                  Include closed requests
                </Button>
              }
            />
          )}
        </Card>
      ) : (
        <div className="grid items-start gap-4 2xl:grid-cols-2">
          {requests.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              onQuote={() => setQuoteFor(request)}
              onDecline={() => setDeclineFor(request)}
            />
          ))}
        </div>
      )}

      {/* -- Footnote -------------------------------------------------------- */}
      {requests.length > 0 && (
        <p className="mt-5 flex items-start gap-2 text-[11.5px] leading-relaxed text-[#7e8c94]">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Replying is not a commitment to sell — the buyer still compares
            every quote, and an administrator still has to approve the purchase
            order before anything is issued to you.
          </span>
        </p>
      )}

      {/* Keyed on the request id so a fresh form is built for each one rather
          than a stale draft being carried across. */}
      {quoteFor && (
        <QuoteModal
          key={quoteFor.id}
          request={quoteFor}
          onClose={() => setQuoteFor(null)}
        />
      )}

      {declineFor && (
        <DeclineModal
          key={declineFor.id}
          request={declineFor}
          onClose={() => setDeclineFor(null)}
        />
      )}
    </>
  );
}
