"use client";

/**
 * Supplier comparison — screens 5a (single item) and 11a (multi item).
 *
 * This is the screen the product's central claim rests on: the agent's choice
 * is not an opinion, it is arithmetic you can redo by hand. So everything the
 * scorer used is on the page — the weights, the per-criterion contributions,
 * which numbers were measured and which were imputed, what was excluded and
 * why, and the exact lines every vendor quoted.
 *
 * Three backend rules this screen has to make legible:
 *
 *   1. A field a vendor never published is not a penalty. It gets a neutral
 *      sub-score, its weight is subtracted from the quote's data confidence,
 *      and the gap is named. An incomplete quote can still win.
 *   2. Reliability is real fulfilment history or nothing. "No history yet" is
 *      the honest answer, and it is never dressed up as a rating.
 *   3. Every figure is frozen at quote time. The purchase order references the
 *      quote rather than the live catalog, so a vendor republishing mid-run
 *      cannot move the price of an order already in flight.
 *
 * A 404 here means the `fetch_quotes` step has not run yet — that is a state,
 * not a failure, and it renders as one.
 */
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Award,
  Boxes,
  Building2,
  ChevronDown,
  CircleSlash,
  History,
  Info,
  ShieldCheck,
  Truck,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { use, useMemo, useState, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Mono,
  Panel,
  Skeleton,
  StatTile,
  StatusPill,
  cn,
} from "@/components/ui";
import { ScoreBar, WeightSummary } from "@/components/workflow/ScoreBar";
import { WorkflowNav } from "@/components/workflow/WorkflowNav";
import { ApiError, api } from "@/lib/api";
import {
  QUOTE_STATUS_LABEL,
  WORKFLOW_STATUS_LABEL,
  WORKFLOW_STATUS_TONE,
  asNumber,
  dateTime,
  humanise,
  money,
  moneyCompact,
  number,
} from "@/lib/format";
import type { Quote, QuoteLine, QuoteStatus } from "@/lib/types";

/* ==========================================================================
   Vocabulary and small derivations
   ========================================================================== */

/** Selected first, then the ranked field, then the excluded, worst last. */
const STATUS_RANK: Record<QuoteStatus, number> = {
  selected: 0,
  quoted: 1,
  excluded_coverage: 2,
  excluded_stock: 3,
  excluded_budget: 4,
};

/** The confidence caveat, in the words a buyer would use. */
const MISSING_FIELD_COPY: Record<string, string> = {
  delivery_days: "delivery time not specified",
  warranty_months: "warranty not specified",
  reliability: "no fulfilment history",
};

function isExcluded(quote: Quote): boolean {
  return quote.status.startsWith("excluded_");
}

function statusLabel(status: QuoteStatus): string {
  return QUOTE_STATUS_LABEL[status] ?? humanise(status);
}

function compareQuotes(a: Quote, b: Quote): number {
  const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (byStatus !== 0) return byStatus;
  const byScore = (asNumber(b.score_total) ?? -1) - (asNumber(a.score_total) ?? -1);
  if (byScore !== 0) return byScore;
  return (
    (asNumber(a.total_amount) ?? Number.MAX_SAFE_INTEGER) -
    (asNumber(b.total_amount) ?? Number.MAX_SAFE_INTEGER)
  );
}

function days(value: number | null | undefined): string {
  if (value == null) return "Not specified";
  return `${number(value)} ${value === 1 ? "day" : "days"}`;
}

function months(value: number | null | undefined): string {
  if (value == null) return "Not specified";
  return `${number(value)} ${value === 1 ? "month" : "months"}`;
}

/**
 * Never fabricated. Without fulfilment history there is no score to show, and
 * the answer to that is a sentence, not a row of half-lit stars.
 */
function hasReliability(quote: Quote): boolean {
  return quote.reliability_has_history && asNumber(quote.reliability_score) !== null;
}

function reliabilityLabel(quote: Quote): string {
  if (!hasReliability(quote)) return "No history yet";
  return `${number(quote.reliability_score, 1)} / 5`;
}

function missingFieldsCopy(fields: string[]): string {
  return fields
    .map(
      (field) =>
        MISSING_FIELD_COPY[field] ?? `${humanise(field).toLowerCase()} not specified`,
    )
    .join(", ");
}

/* ==========================================================================
   Local primitives — this file owns them
   ========================================================================== */

function LinkButton({
  href,
  children,
  icon,
}: {
  href: string;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex h-11 items-center gap-2 rounded-[14px] border border-white/80 bg-white/75 px-5 text-[13.5px] font-semibold text-[#243640] shadow-[0_8px_22px_rgba(46,96,120,0.10)] backdrop-blur-md transition-all duration-200 hover:bg-white/95"
    >
      {icon}
      {children}
    </Link>
  );
}

function SectionHead({
  eyebrow,
  title,
  note,
}: {
  eyebrow: string;
  title: string;
  note?: string;
}) {
  return (
    <div className="mb-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
        {eyebrow}
      </p>
      <h2 className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
        {title}
      </h2>
      {note && (
        <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-[#7e8c94]">
          {note}
        </p>
      )}
    </div>
  );
}

/** One measured fact. `tile` is the winner card's heavier treatment. */
function Fact({
  label,
  value,
  hint,
  icon,
  tile = false,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  tile?: boolean;
}) {
  return (
    <div className={cn(tile && "rounded-[16px] bg-white/55 px-3.5 py-3")}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
        {icon}
        {label}
      </p>
      <p
        className={cn(
          "mt-1 font-semibold tracking-[-0.01em] text-[#243640] tnum",
          tile ? "text-[15px]" : "text-[13px]",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-[#7e8c94]">{hint}</p>}
    </div>
  );
}

/**
 * The caveat chip. A quote scored entirely on published numbers reads as a
 * quiet neutral; anything imputed is warning-toned and names what is missing,
 * because that is the difference between a confident score and a polite guess.
 */
function ConfidenceChip({
  percent,
  missing,
}: {
  percent: number;
  missing: string[];
}) {
  const complete = percent >= 100 && missing.length === 0;
  const label =
    missing.length > 0
      ? `Data confidence ${number(percent)}% (${missingFieldsCopy(missing)})`
      : `Data confidence ${number(percent)}%`;
  return (
    <StatusPill
      size="sm"
      dot={false}
      tone={complete ? "neutral" : "warning"}
      label={label}
      className="max-w-full text-left leading-relaxed"
    />
  );
}

const HEAD_CELL =
  "border-b border-[#e0ebf0] px-4 pb-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]";
const BODY_CELL = "border-b border-[#eef4f7] px-4 py-3 text-[13px] text-[#243640]";

/** The receipt for one quote: what was matched, at what price, on what terms. */
function QuoteLines({ quote }: { quote: Quote }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-[14px] px-3 py-2.5 text-[12.5px] font-semibold text-[#38677b] transition-colors duration-200 hover:bg-white/70"
      >
        <span>
          {open ? "Hide" : "Show"} line items{" "}
          <span className="font-medium text-[#7e8c94] tnum">
            ({number(quote.lines.length)})
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="animate-fade-in mt-1 overflow-x-auto">
          <table className="w-full min-w-[720px] border-separate border-spacing-0 text-left">
            <thead>
              <tr>
                <th className={cn(HEAD_CELL, "pl-3")}>Item</th>
                <th className={HEAD_CELL}>Matched product</th>
                <th className={HEAD_CELL}>SKU</th>
                <th className={cn(HEAD_CELL, "text-right")}>Qty</th>
                <th className={cn(HEAD_CELL, "text-right")}>Unit price</th>
                <th className={cn(HEAD_CELL, "text-right")}>Line total</th>
                <th className={cn(HEAD_CELL, "text-right")}>Delivery</th>
                <th className={cn(HEAD_CELL, "pr-3 text-right")}>Warranty</th>
              </tr>
            </thead>
            <tbody>
              {quote.lines.map((line, index) => (
                <tr
                  key={`${line.request_item_name}-${line.sku ?? index}`}
                  className={cn(!line.available && "opacity-65")}
                >
                  <td className={cn(BODY_CELL, "pl-3 font-medium")}>
                    {line.request_item_name}
                  </td>
                  <td className={BODY_CELL}>
                    {line.available ? (
                      (line.matched_title ?? "—")
                    ) : (
                      <span className="text-[12px] font-semibold text-[#b54708]">
                        Not stocked
                      </span>
                    )}
                  </td>
                  <td className={BODY_CELL}>
                    {line.sku ? (
                      <Mono>{line.sku}</Mono>
                    ) : (
                      <span className="text-[#b3c4cc]">—</span>
                    )}
                  </td>
                  <td className={cn(BODY_CELL, "text-right tnum")}>
                    {number(line.quantity)}
                  </td>
                  <td className={cn(BODY_CELL, "text-right tnum")}>
                    {money(line.unit_price, quote.currency)}
                  </td>
                  <td className={cn(BODY_CELL, "text-right font-semibold tnum")}>
                    {money(line.line_total, quote.currency)}
                  </td>
                  <td className={cn(BODY_CELL, "text-right tnum")}>
                    {line.delivery_days == null
                      ? "—"
                      : `${number(line.delivery_days)} d`}
                  </td>
                  <td className={cn(BODY_CELL, "pr-3 text-right tnum")}>
                    {line.warranty_months == null
                      ? "—"
                      : `${number(line.warranty_months)} mo`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   The winner — screen 5a's distinguished card
   ========================================================================== */

function WinnerCard({
  quote,
  budget,
  rankedOf,
}: {
  quote: Quote;
  budget: number | null;
  rankedOf: number;
}) {
  const total = asNumber(quote.total_amount);
  const headroom = budget !== null && total !== null ? budget - total : null;

  return (
    <Card padded={false} className="animate-fade-up overflow-hidden">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* ---- Identity and money ---- */}
        <div className="border-b border-white/60 p-6 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#17b26a] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-white shadow-[0_8px_18px_rgba(23,178,106,0.35)]">
              <Award className="size-3.5" strokeWidth={2.5} />
              Best option
            </span>
            <span className="text-[11.5px] text-[#7e8c94]">
              Quoted {dateTime(quote.snapshot_taken_at)}
            </span>
          </div>

          <h2 className="mt-4 text-[24px] font-bold leading-tight tracking-[-0.03em] text-[#101828]">
            {quote.vendor_name}
          </h2>

          <p className="mt-4 text-[34px] font-bold leading-none tracking-[-0.03em] text-[#101828] tnum">
            {money(quote.total_amount, quote.currency)}
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-[#5f7280]">
            {headroom === null
              ? "Quoted total for the whole request."
              : headroom >= 0
                ? `${money(headroom, quote.currency)} under the budget ceiling.`
                : `${money(Math.abs(headroom), quote.currency)} over the budget ceiling.`}
          </p>

          <div className="mt-5 grid grid-cols-2 gap-2.5">
            <Fact
              tile
              icon={<Truck className="size-3.5" />}
              label="Delivery"
              value={days(quote.delivery_days)}
            />
            <Fact
              tile
              icon={<ShieldCheck className="size-3.5" />}
              label="Warranty"
              value={months(quote.warranty_months)}
            />
            <Fact
              tile
              icon={<History className="size-3.5" />}
              label="Reliability"
              value={reliabilityLabel(quote)}
              hint={
                hasReliability(quote)
                  ? "from fulfilled orders"
                  : "no orders fulfilled yet"
              }
            />
            <Fact
              tile
              icon={<Boxes className="size-3.5" />}
              label="Coverage"
              value={`${number(quote.items_covered)} of ${number(
                quote.items_requested,
              )} items`}
            />
          </div>
        </div>

        {/* ---- The maths ---- */}
        <div className="p-6">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
              Weighted score
            </p>
            <p className="tnum">
              <span className="text-[32px] font-bold leading-none tracking-[-0.03em] text-[#243640]">
                {number(quote.score_total, 1)}
              </span>
              <span className="ml-1 text-[13px] font-semibold text-[#7e8c94]">
                / 100
              </span>
            </p>
          </div>

          {quote.score ? (
            <>
              <ScoreBar
                className="mt-4"
                components={quote.score.components}
                total={asNumber(quote.score_total)}
                height={12}
              />
              <WeightSummary className="mt-3" components={quote.score.components} />
            </>
          ) : (
            <p className="mt-4 text-[12.5px] leading-relaxed text-[#7e8c94]">
              No breakdown was recorded for this quote.
            </p>
          )}

          <p className="mt-4 text-[12.5px] leading-relaxed text-[#5f7280]">
            Highest weighted total of {number(rankedOf)}{" "}
            {rankedOf === 1 ? "scored quote" : "scored quotes"}. Selected, not bought —
            the graph stops at a human gate before anything is committed.
          </p>

          {quote.confidence_percent != null && (
            <div className="mt-4">
              <ConfidenceChip
                percent={quote.confidence_percent}
                missing={quote.missing_fields ?? []}
              />
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-white/60 px-4 py-2">
        <QuoteLines quote={quote} />
      </div>
    </Card>
  );
}

/* ==========================================================================
   The field — every other quote, excluded ones included and de-emphasised
   ========================================================================== */

function QuoteCard({ quote, rank }: { quote: Quote; rank: number | null }) {
  const excluded = isExcluded(quote);

  return (
    <Card
      as="article"
      variant={excluded ? "flat" : "glass"}
      padded={false}
      className={cn(
        "animate-fade-up flex flex-col p-5 transition-all duration-200",
        excluded ? "opacity-[0.72] hover:opacity-100" : "hover:-translate-y-0.5",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {rank !== null && (
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#e9f3f8] text-[11px] font-bold text-[#38677b] tnum">
                {rank}
              </span>
            )}
            <h3 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
              {quote.vendor_name}
            </h3>
          </div>
          <p className="mt-1 text-[11.5px] text-[#7e8c94]">
            Quoted {dateTime(quote.snapshot_taken_at)}
          </p>
        </div>
        <StatusPill
          size="sm"
          tone={excluded ? "danger" : "neutral"}
          label={statusLabel(quote.status)}
        />
      </div>

      {excluded && (
        <p className="mt-3 flex items-start gap-2 rounded-[14px] border border-[#fecdca] bg-[#fef3f2] px-3 py-2 text-[12px] font-semibold leading-relaxed text-[#b42318]">
          <CircleSlash className="mt-px size-3.5 shrink-0" />
          {quote.exclusion_reason ?? `${statusLabel(quote.status)} — excluded`}
        </p>
      )}

      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            Total
          </p>
          <p className="mt-1 text-[22px] font-bold leading-none tracking-[-0.03em] text-[#101828] tnum">
            {money(quote.total_amount, quote.currency)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            Score
          </p>
          {quote.score_total == null ? (
            <p className="mt-1 text-[13px] font-semibold text-[#7e8c94]">Not scored</p>
          ) : (
            <p className="mt-1 tnum">
              <span className="text-[22px] font-bold leading-none tracking-[-0.03em] text-[#243640]">
                {number(quote.score_total, 1)}
              </span>
              <span className="ml-1 text-[12px] font-semibold text-[#7e8c94]">
                / 100
              </span>
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[#eef4f7] pt-4">
        <Fact label="Delivery" value={days(quote.delivery_days)} />
        <Fact label="Warranty" value={months(quote.warranty_months)} />
        <Fact label="Reliability" value={reliabilityLabel(quote)} />
        <Fact
          label="Coverage"
          value={`${number(quote.items_covered)} of ${number(
            quote.items_requested,
          )} items`}
        />
      </div>

      <div className="mt-4">
        {quote.score ? (
          <>
            <ScoreBar
              components={quote.score.components}
              total={asNumber(quote.score_total)}
              height={9}
            />
            <WeightSummary className="mt-2.5" components={quote.score.components} />
          </>
        ) : excluded ? (
          <p className="text-[12px] leading-relaxed text-[#7e8c94]">
            Excluded before scoring — the agent does not spend a scoring pass on a quote
            it cannot buy.
          </p>
        ) : (
          <p className="text-[12px] leading-relaxed text-[#7e8c94]">
            No score breakdown was recorded for this quote.
          </p>
        )}
      </div>

      {quote.confidence_percent != null && (
        <div className="mt-3">
          <ConfidenceChip
            percent={quote.confidence_percent}
            missing={quote.missing_fields ?? []}
          />
        </div>
      )}

      <div className="mt-auto pt-3">
        <QuoteLines quote={quote} />
      </div>
    </Card>
  );
}

/* ==========================================================================
   Coverage matrix — screen 11a
   ========================================================================== */

function CoverageCell({
  line,
  currency,
}: {
  line: QuoteLine | undefined;
  currency: string;
}) {
  if (!line) {
    return <span className="text-[12.5px] text-[#b3c4cc]">Not quoted</span>;
  }
  if (!line.available) {
    return (
      <span className="inline-flex items-center rounded-full border border-[#fedf89] bg-[#fffaeb] px-2 py-0.5 text-[11px] font-semibold text-[#b54708]">
        Not stocked
      </span>
    );
  }
  return (
    <>
      <span className="block text-[12.5px] font-medium leading-snug text-[#243640]">
        {line.matched_title ?? "Matched from catalog"}
      </span>
      <span className="mt-1 block text-[11.5px] text-[#7e8c94] tnum">
        {number(line.quantity)} ×{" "}
        <span className="font-semibold text-[#243640]">
          {money(line.line_total, currency)}
        </span>
      </span>
    </>
  );
}

/**
 * Rows are the UNION of every quote's line names, in first-seen order — a
 * vendor that skipped an item must still get a "Not quoted" cell for it, so
 * taking the rows from any single quote would silently hide the gap.
 */
function coverageRowsOf(quotes: Quote[]): string[] {
  const seen: string[] = [];
  for (const quote of quotes) {
    for (const line of quote.lines) {
      if (!seen.includes(line.request_item_name)) seen.push(line.request_item_name);
    }
  }
  return seen;
}

function CoverageMatrix({ quotes, rows }: { quotes: Quote[]; rows: string[] }) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="overflow-x-auto pb-5">
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              <th
                className={cn(
                  HEAD_CELL,
                  "sticky left-0 z-10 min-w-[180px] bg-white/85 pl-6 pt-5 align-bottom backdrop-blur-sm",
                )}
              >
                Request item
              </th>
              {quotes.map((quote, index) => (
                <th
                  key={quote.id}
                  className={cn(
                    HEAD_CELL,
                    "min-w-[190px] pt-5 align-bottom normal-case tracking-normal",
                    index === quotes.length - 1 && "pr-6",
                    isExcluded(quote) && "opacity-60",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#243640]">
                    {quote.status === "selected" && (
                      <Award
                        className="size-3.5 shrink-0 text-[#17b26a]"
                        strokeWidth={2.5}
                      />
                    )}
                    <span className="truncate">{quote.vendor_name}</span>
                  </span>
                  <span className="mt-0.5 block text-[11px] font-medium text-[#7e8c94] tnum">
                    Covers {number(quote.items_covered)}/{number(quote.items_requested)}{" "}
                    items
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row}>
                <td
                  className={cn(
                    BODY_CELL,
                    "sticky left-0 z-10 bg-white/85 pl-6 font-semibold backdrop-blur-sm",
                  )}
                >
                  {row}
                </td>
                {quotes.map((quote, index) => (
                  <td
                    key={quote.id}
                    className={cn(
                      BODY_CELL,
                      "align-top",
                      index === quotes.length - 1 && "pr-6",
                      isExcluded(quote) && "opacity-60",
                    )}
                  >
                    <CoverageCell
                      line={quote.lines.find(
                        (line) => line.request_item_name === row,
                      )}
                      currency={quote.currency}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ==========================================================================
   Page
   ========================================================================== */

export default function ComparisonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const workflowQuery = useQuery({
    queryKey: ["workflow", id],
    queryFn: () => api.getWorkflow(id),
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["comparison", id],
    queryFn: () => api.getComparison(id),
  });

  const quotes = useMemo(() => [...(data ?? [])].sort(compareQuotes), [data]);
  const coverageRows = useMemo(() => coverageRowsOf(quotes), [quotes]);

  const workflow = workflowQuery.data;
  const currency = quotes[0]?.currency ?? workflow?.currency ?? "PKR";
  const budget = asNumber(workflow?.budget ?? null);

  const winner = quotes.find((quote) => quote.status === "selected") ?? null;
  const field = quotes.filter((quote) => quote.id !== winner?.id);
  const excluded = quotes.filter(isExcluded);
  const contenders = quotes.filter((quote) => !isExcluded(quote));
  const rankOf = new Map(contenders.map((quote, index) => [quote.id, index + 1]));
  /**
   * Screen 11a. `items_requested` is the authority, but a request whose extra
   * lines no vendor could match still has one row per distinct line — so the
   * union is checked too, and the section only renders when it has rows.
   */
  const multiItem =
    (quotes.some((quote) => quote.items_requested > 1) || coverageRows.length > 1) &&
    coverageRows.length > 0;

  const exclusionCounts = new Map<QuoteStatus, number>();
  for (const quote of excluded) {
    exclusionCounts.set(quote.status, (exclusionCounts.get(quote.status) ?? 0) + 1);
  }
  const exclusionSummary = Array.from(exclusionCounts.entries())
    .map(([status, count]) => `${statusLabel(status)} ${number(count)}`)
    .join(" · ");

  const snapshots = quotes.map((quote) => quote.snapshot_taken_at).sort();
  const snapshotAt = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  const winnerTotal = winner ? asNumber(winner.total_amount) : null;
  const headroom =
    budget !== null && winnerTotal !== null ? budget - winnerTotal : null;

  const chrome = (
    <>
      <PageHeader
        breadcrumb={
          <Link
            href={`/workflows/${id}`}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[#5f7280] transition-colors duration-200 hover:text-[#447f98]"
          >
            <ArrowLeft className="size-3.5" />
            {workflow?.title ?? "Back to execution"}
          </Link>
        }
        title="Supplier comparison"
        description="Every quote the agent gathered, scored on one set of weights. The winner is the highest weighted total — not the cheapest by default — and the quotes that lost stay on the page with the reason they lost."
        actions={
          workflow ? (
            <StatusPill
              label={WORKFLOW_STATUS_LABEL[workflow.status]}
              tone={WORKFLOW_STATUS_TONE[workflow.status]}
            />
          ) : undefined
        }
      />
      <WorkflowNav workflowId={id} className="mb-6" />
    </>
  );

  /* ---- Loading ---------------------------------------------------------- */
  if (isLoading) {
    return (
      <>
        {chrome}
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-[124px] rounded-[28px]" />
            ))}
          </div>
          <Skeleton className="h-[320px] rounded-[28px]" />
          <LoadingBlock rows={2} />
        </div>
      </>
    );
  }

  /* ---- Not produced yet: a state, not an error -------------------------- */
  if (error instanceof ApiError && error.isNotFound) {
    return (
      <>
        {chrome}
        <EmptyState
          icon={<Boxes className="size-6" />}
          title="The agent has not gathered quotes for this workflow yet"
          description="Supplier quotes appear here once the fetch_quotes step has run and the scorer has ranked them. Follow the run on the execution screen — this page fills in the moment the comparison is ready."
          action={
            <LinkButton href={`/workflows/${id}`} icon={<ArrowLeft className="size-4" />}>
              Back to execution
            </LinkButton>
          }
        />
      </>
    );
  }

  /* ---- Error ------------------------------------------------------------ */
  if (error) {
    return (
      <>
        {chrome}
        <ErrorState error={error} onRetry={() => void refetch()} />
      </>
    );
  }

  /* ---- Empty ------------------------------------------------------------ */
  if (quotes.length === 0) {
    return (
      <>
        {chrome}
        <EmptyState
          icon={<Boxes className="size-6" />}
          title="No supplier quotes were recorded"
          description="The comparison ran but returned nothing to compare. That normally means no vendor in the catalog matched the request — which the agent escalates to a human rather than resolving on its own."
          action={
            <LinkButton href={`/workflows/${id}`} icon={<ArrowLeft className="size-4" />}>
              Back to execution
            </LinkButton>
          }
        />
      </>
    );
  }

  /* ---- Data ------------------------------------------------------------- */
  return (
    <>
      {chrome}

      <div className="space-y-8">
        {/* The shape of the decision, in four numbers */}
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Suppliers compared"
            value={number(quotes.length)}
            icon={<Building2 className="size-4" />}
            sub={`${number(contenders.length)} in contention · ${number(
              excluded.length,
            )} excluded`}
          />
          <StatTile
            label="Excluded"
            value={number(excluded.length)}
            tone={excluded.length > 0 ? "warning" : "neutral"}
            icon={<CircleSlash className="size-4" />}
            sub={exclusionSummary || "Every quote qualified for scoring"}
          />
          <StatTile
            label="Budget ceiling"
            value={
              workflowQuery.error
                ? "Unavailable"
                : workflowQuery.isPending
                  ? "…"
                  : budget !== null
                    ? moneyCompact(budget, currency)
                    : "Not set"
            }
            icon={<Wallet className="size-4" />}
            sub={
              workflowQuery.error
                ? "The workflow header could not be loaded"
                : workflowQuery.isPending
                  ? "Reading the workflow header"
                  : budget !== null
                    ? "Applied before scoring — an over-budget quote never ranks"
                    : "No ceiling was set on this request"
            }
          />
          <StatTile
            label="Winning total"
            value={winner ? moneyCompact(winner.total_amount, winner.currency) : "—"}
            tone={winner ? "positive" : "warning"}
            icon={<Award className="size-4" />}
            sub={
              !winner
                ? "No quote qualified — escalated to a human"
                : headroom === null
                  ? winner.vendor_name
                  : headroom >= 0
                    ? `${winner.vendor_name} · ${money(
                        headroom,
                        currency,
                      )} under the ceiling`
                    : `${winner.vendor_name} · ${money(
                        Math.abs(headroom),
                        currency,
                      )} over the ceiling`
            }
          />
        </section>

        {/* The winner */}
        <section>
          <SectionHead
            eyebrow="The decision"
            title="Selected supplier"
            note="Selected, not committed. The graph interrupts here and waits for an administrator."
          />
          {winner ? (
            <WinnerCard
              quote={winner}
              budget={budget}
              rankedOf={contenders.length}
            />
          ) : (
            <Alert tone="warning" title="No supplier was selected">
              Every quote was excluded before a winner could be chosen. When nothing
              qualifies, the agent escalates to a human instead of relaxing the constraint
              on its own — the reason sits on each card below.
            </Alert>
          )}
        </section>

        {/* The field */}
        <section>
          <SectionHead
            eyebrow="The field"
            title={`${number(field.length)}${winner ? " other" : ""} ${
              field.length === 1 ? "quote" : "quotes"
            }`}
            note="Scored on the same weights. Excluded quotes stay on the page — a decision whose losers you cannot see is not auditable."
          />
          {field.length === 0 ? (
            <Card variant="flat" className="text-[12.5px] leading-relaxed text-[#7e8c94]">
              No other supplier returned a quote for this request. A single-quote
              comparison still records the full score, so the reasoning survives the run.
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {field.map((quote) => (
                <QuoteCard
                  key={quote.id}
                  quote={quote}
                  rank={rankOf.get(quote.id) ?? null}
                />
              ))}
            </div>
          )}
        </section>

        {/* Multi-item coverage — screen 11a */}
        {multiItem && (
          <section>
            <SectionHead
              eyebrow="Multi-item request"
              title="Who can supply what"
              note={`${number(coverageRows.length)} request lines against ${number(
                quotes.length,
              )} suppliers. A vendor that cannot stock a line is not disqualified for it — it earns no coverage there, and the agent weighs a complete order against a cheaper partial one.`}
            />
            <CoverageMatrix quotes={quotes} rows={coverageRows} />
          </section>
        )}

        {/* Footnotes — the parts of the method that are not self-evident */}
        <Panel
          variant="soft"
          icon={<Info className="size-4" />}
          title="How to read this comparison"
          bodyClassName="space-y-3.5 text-[12.5px] leading-relaxed text-[#5f7280]"
        >
          <p>
            <span className="font-semibold text-[#243640]">
              Missing data is a caveat, not a penalty.
            </span>{" "}
            When a vendor does not publish a warranty or a delivery time, that criterion
            gets a neutral sub-score rather than a zero, and the quote is never excluded
            for it. What changes instead is data confidence: the weight of the unpublished
            criterion is subtracted, and the gap is named on the chip. That is why an
            incomplete quote can still win on the criteria it did supply — and how you can
            tell how much of a score rests on real numbers. A hatched segment in a score
            bar marks an imputed value.
          </p>
          <p>
            <span className="font-semibold text-[#243640]">
              Reliability is history or nothing.
            </span>{" "}
            A supplier with no fulfilled orders reads &ldquo;No history yet&rdquo;. The
            agent does not invent a rating to fill the column, and a new vendor is not
            punished for being new.
          </p>
          <p>
            <span className="font-semibold text-[#243640]">
              Every figure is a snapshot.
            </span>{" "}
            Prices, delivery times and warranty terms were frozen when the quotes were
            taken — {dateTime(snapshotAt)} — and the purchase order references the quote
            rather than the live catalog. A vendor republishing its catalog mid-run cannot
            change an order that is already in flight.
          </p>
        </Panel>
      </div>
    </>
  );
}
