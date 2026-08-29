"use client";

/**
 * Screen 18a detail — one vendor, everything on record.
 *
 * The management list shows enough to decide verify/suspend at a glance. This
 * is the view for when that is not enough: the reliability history the scorer
 * actually reads, the open flags behind it, and what the vendor lists.
 *
 * Three backend facts shape the copy on this page.
 *
 *  - Reliability is never invented. `_reliability_display` in
 *    `routers/vendors.py` sets `has_history` only once the vendor has fulfilled
 *    at least the configured minimum number of orders. Below that,
 *    `build_components` in `scoring/normalizers.py` KEEPS the reliability
 *    criterion and substitutes `settings.scoring.new_vendor_neutral_reliability`
 *    — the neutral mid-point, not zero — then marks the component
 *    `was_imputed`, which is what lowers the quote's data confidence. So a new
 *    supplier is not penalised for being new, and this screen shows no number
 *    at all rather than a flattering or a damning guess. (The criterion is
 *    dropped only when an administrator sets its weight to zero, which is a
 *    scoring-policy decision and nothing to do with this vendor.)
 *  - Flags come from a background monitor, not from a person. It compares
 *    recorded fulfilment against the configured thresholds and raises a row. A
 *    flag is a warning carried into the approval justification, not a ban:
 *    `selectable_for_quoting` excludes only SUSPENDED vendors.
 *  - `/catalog/browse` returns published, visible items from verified or
 *    flagged vendors only — exactly the set the agent itself can quote from.
 *    An empty table therefore means "nothing the agent could use", not "this
 *    vendor has no catalog".
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Boxes,
  Building2,
  Flag,
  Gauge,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Truck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  Mono,
  Panel,
  Skeleton,
  StatTile,
  StatusPill,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
  useToast,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  VENDOR_STATUS_LABEL,
  VENDOR_STATUS_TONE,
  dateOnly,
  dateTime,
  humanise,
  money,
  number as formatNumber,
  percent,
  relativeTime,
  type Tone,
} from "@/lib/format";
import type { CatalogItem, Vendor, VendorFlag, VendorStatus } from "@/lib/types";

/** The agent reads published items; sixty is plenty to characterise a range. */
const CATALOG_LIMIT = 60;

/**
 * `VendorFlagReason` in prose.
 *
 * The raw enum values are machine keys — `humanise("low_on_time_rate")` gives
 * "Low on time rate", which reads like a typo. Anything the monitor adds later
 * still falls through to `humanise` rather than to nothing.
 */
const FLAG_REASON_LABEL: Record<string, string> = {
  late_deliveries: "Late deliveries",
  low_on_time_rate: "Low on-time rate",
  cancellations: "Cancellations",
  quantity_shortfall: "Quantity shortfall",
};

/** What each flag actually measures, in the monitor's own terms. */
const FLAG_EXPLANATION: Record<string, string> = {
  late_deliveries:
    "Deliveries arrived after the expected date more often than the configured tolerance allows.",
  low_on_time_rate:
    "The share of orders delivered on time fell below the configured floor.",
  cancellations: "The vendor cancelled more orders than the configured limit.",
  quantity_shortfall:
    "Delivered quantities fell short of what the purchase order specified.",
};

/** "1 day" / "7 days" — `formatNumber` still does the grouping. */
function plural(value: number, singular: string, many = `${singular}s`): string {
  return `${formatNumber(value)} ${value === 1 ? singular : many}`;
}

/**
 * Warranty the way the Flutter screen said it.
 *
 * `formatWarranty` in `widgets/common.dart` collapses whole years, because a
 * warranty is quoted in years far more often than in months: 24 reads as
 * "2 years", 18 stays "18 months". Zero is stated outright rather than
 * rendered as the "0 years" the Dart version would have produced.
 */
function warrantyTerm(months: number): string {
  if (months === 0) return "No warranty";
  if (months % 12 === 0) return plural(months / 12, "year");
  return plural(months, "month");
}

/**
 * The Flutter screen's thresholds, unchanged: 90% and above is healthy, 75%
 * and above is worth watching, anything below that needs a decision.
 */
function onTimeTone(rate: number): Tone {
  if (rate >= 0.9) return "positive";
  if (rate >= 0.75) return "warning";
  return "danger";
}

/* ==========================================================================
   Local pieces
   ========================================================================== */

/** A refusal or an absence, explained rather than alarmed about. */
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
        href="/vendors"
        className="mt-5 inline-flex h-10 items-center gap-2 rounded-[14px] border border-white/80 bg-white/75 px-4 text-[13px] font-semibold text-[#243640] shadow-[0_8px_22px_rgba(46,96,120,0.10)] transition-colors duration-200 hover:bg-white/95"
      >
        <ArrowLeft className="size-4" />
        Back to the directory
      </Link>
    </Card>
  );
}

function ContactRow({
  icon,
  label,
  value,
  href,
}: {
  icon: ReactNode;
  label: string;
  value: string | null;
  href?: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-[18px] bg-white/55 px-3.5 py-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[10px] bg-[#e9f3f8] text-[#447f98]">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
          {label}
        </p>
        {value ? (
          href ? (
            <a
              href={href}
              className="mt-0.5 block break-words text-[13px] font-semibold text-[#38677b] underline decoration-[#b9d8e1] underline-offset-2 transition-colors duration-200 hover:text-[#447f98]"
            >
              {value}
            </a>
          ) : (
            <p className="mt-0.5 break-words text-[13px] font-semibold text-[#243640]">
              {value}
            </p>
          )
        ) : (
          <p className="mt-0.5 text-[13px] text-[#a9bac3]">—</p>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Reliability — the heart of the screen
   -------------------------------------------------------------------------- */
function ReliabilityBlock({ vendor }: { vendor: Vendor }) {
  const reliability = vendor.reliability;

  const provenance = (
    <p className="mt-4 text-[11.5px] leading-relaxed text-[#7e8c94]">
      These figures are computed from real purchase-order fulfilment recorded
      through the vendor portal — the delivery dates and quantities the supplier
      itself confirmed against issued orders. Nothing on this panel is
      estimated, sampled or fabricated.
    </p>
  );

  if (!reliability.has_history) {
    return (
      <Panel
        className="animate-fade-up"
        icon={<Gauge className="size-4" />}
        title="No delivery history"
        description="Reliability is one of the four scoring criteria — and this vendor has not yet earned a figure for it."
      >
        <Alert
          tone="brand"
          title="The scorer holds reliability neutral; it does not score it zero"
        >
          <p>
            This vendor has not fulfilled enough purchase orders for the
            reliability signal to mean anything. Rather than read that absence
            as a zero, the scorer keeps the criterion and substitutes the
            configured neutral value — the mid-point, neither credit nor
            penalty. A new supplier is not penalised for being new, and it is
            not flattered either.
          </p>
          <p className="mt-2 opacity-90">
            The substitution is recorded on the quote as an imputed component,
            and that is what lowers its data-confidence percentage: an approver
            can see that the reliability share of the score rests on an
            assumption rather than on this vendor&apos;s own record. Once
            delivered orders reach the configured minimum, the real figures
            appear here and carry the criterion on their own.
          </p>
        </Alert>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-[18px] bg-white/55 px-4 py-3">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
              Orders fulfilled so far
            </dt>
            <dd className="mt-1 text-[15px] font-bold text-[#243640] tnum">
              {formatNumber(reliability.orders_fulfilled)}
            </dd>
          </div>
          <div className="rounded-[18px] bg-white/55 px-4 py-3">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
              Rating shown to buyers
            </dt>
            <dd className="mt-1 text-[15px] font-bold text-[#5f7280]">
              {reliability.display}
            </dd>
          </div>
        </dl>
        {provenance}
      </Panel>
    );
  }

  // `has_history` turns on the order count alone, so a vendor can cross the
  // threshold before an on-time rate has been recorded against it. Reading a
  // missing rate as zero would paint it red — the damning guess this panel
  // exists to avoid — so an absent rate is shown as absent, untoned.
  const rate = reliability.on_time_rate;

  return (
    <Panel
      className="animate-fade-up"
      icon={<Gauge className="size-4" />}
      title="Reliability"
      description="The history the scorer reads when it weighs this vendor against the others."
      actions={
        rate === null ? (
          <StatusPill
            size="sm"
            tone="muted"
            dot={false}
            label="On-time rate not recorded"
          />
        ) : (
          <StatusPill
            size="sm"
            tone={onTimeTone(rate)}
            label={`${percent(rate)} on time`}
          />
        )
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile
          label="On-time rate"
          value={percent(rate)}
          tone={rate === null ? "neutral" : onTimeTone(rate)}
          sub={
            rate === null
              ? "No delivery has been timed against its expected date yet."
              : "Share of orders delivered by the expected date."
          }
        />
        <StatTile
          label="Orders fulfilled"
          value={formatNumber(reliability.orders_fulfilled)}
          sub="Completed purchase orders behind these numbers."
        />
        <StatTile
          label="Quantity accuracy"
          value={percent(reliability.quantity_accuracy)}
          sub="Delivered quantity against what the order specified."
        />
        <StatTile
          label="Late deliveries"
          value={formatNumber(reliability.late_deliveries)}
          tone={reliability.late_deliveries > 0 ? "warning" : "neutral"}
          sub="Orders that arrived after the expected date."
        />
        <StatTile
          label="Cancellations"
          value={formatNumber(reliability.cancellations)}
          tone={reliability.cancellations > 0 ? "danger" : "neutral"}
          sub="Orders the vendor withdrew after acknowledging them."
        />
        {/*
          Not `display`: the router renders that as "No history yet" whenever
          the stored aggregate is missing, which inside this branch would
          contradict the panel around it. `score` is the figure this tile
          claims to show, so read it and say plainly when it is absent.
        */}
        <StatTile
          label="Reliability score"
          value={
            reliability.score === null
              ? "Not computed"
              : formatNumber(reliability.score, 1)
          }
          tone={reliability.score === null ? "neutral" : "brand"}
          sub={
            reliability.score === null
              ? "The aggregate has not been recomputed since these orders closed."
              : "The figure fed into the reliability criterion, out of five."
          }
        />
      </div>
      {provenance}
    </Panel>
  );
}

/* --------------------------------------------------------------------------
   Open flags
   -------------------------------------------------------------------------- */
function FlagsBlock({ flags }: { flags: VendorFlag[] }) {
  const open = flags.filter((flag) => !flag.resolved_at);

  return (
    <Panel
      className="animate-fade-up"
      icon={<Flag className="size-4" />}
      title={
        <span className="flex items-center gap-2">
          Open flags
          {open.length > 0 && (
            <Badge tone="danger">{formatNumber(open.length)} open</Badge>
          )}
        </span>
      }
      description="A background monitor compares recorded fulfilment against the configured thresholds and raises these on its own. No one files them by hand — and a flag is a warning carried into the approval justification, not an automatic ban."
    >
      {open.length === 0 ? (
        <EmptyState
          className="py-8"
          icon={<ShieldCheck className="size-6" />}
          title="Nothing flagged"
          description="Every measured figure for this vendor sits inside the configured performance thresholds. A new flag would appear here the moment the monitor raised one."
        />
      ) : (
        <div className="space-y-3">
          {open.map((flag) => (
            <article
              key={`${flag.reason}-${flag.raised_at}`}
              className="animate-fade-up rounded-[20px] border border-[#fecdca] bg-[#fef3f2] px-4 py-3.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-[#b42318]">
                  <AlertTriangle className="size-4 shrink-0" />
                  {FLAG_REASON_LABEL[flag.reason] ?? humanise(flag.reason)}
                </p>
                <span
                  className="shrink-0 text-[11px] text-[#b42318]/70"
                  title={dateTime(flag.raised_at)}
                >
                  Raised {relativeTime(flag.raised_at)}
                </span>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#b42318]/85">
                {flag.detail}
              </p>
              {FLAG_EXPLANATION[flag.reason] && (
                <p className="mt-1 text-[11.5px] leading-relaxed text-[#b42318]/70">
                  {FLAG_EXPLANATION[flag.reason]}
                </p>
              )}
              <p className="mt-2.5 border-t border-[#fecdca] pt-2.5 text-[11px] text-[#b42318]/70">
                Threshold <Mono>{flag.threshold}</Mono>
              </p>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* --------------------------------------------------------------------------
   Their catalog
   -------------------------------------------------------------------------- */
function CatalogBlock({
  items,
  isLoading,
  error,
  onRetry,
}: {
  items: CatalogItem[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const forbidden = error instanceof ApiError && error.isForbidden;
  const missingTerms = items.filter((item) => item.missing_terms.length > 0).length;
  const capped = items.length >= CATALOG_LIMIT;

  return (
    <Panel
      className="animate-fade-up"
      icon={<Boxes className="size-4" />}
      title={
        <span className="flex items-center gap-2">
          Their catalog
          {items.length > 0 && (
            <span className="text-[12px] font-medium text-[#7e8c94] tnum">
              {formatNumber(items.length)}
              {capped ? "+" : ""}
            </span>
          )}
        </span>
      }
      description="Published, visible items only — the same set the agent itself reads when it builds a quote. Drafts and hidden items are deliberately absent, so an empty table does not mean this vendor has no catalog."
    >
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : forbidden ? (
        <Alert tone="neutral" title="Catalog browsing is a buyer view">
          Your session carries the vendor role, so the API declined the browse
          endpoint — the same guard that stops one supplier reading another
          supplier&apos;s pricing. Your own listings live in the portal.
        </Alert>
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : items.length === 0 ? (
        <EmptyState
          className="py-8"
          icon={<Boxes className="size-6" />}
          title="Nothing published for the agent to quote"
          description="This vendor has no published, visible items right now. Until it publishes, the agent has no prices to compare — the vendor may still hold unpublished drafts in its own portal."
        />
      ) : (
        <>
          <Table minWidth={880}>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th>SKU</Th>
                <Th>Category</Th>
                <Th align="right">Price</Th>
                <Th align="right">Stock</Th>
                <Th align="right">Delivery</Th>
                <Th align="right">Warranty</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <Tr key={item.id}>
                  <Td>
                    <p className="font-semibold text-[#243640]">{item.title}</p>
                    {item.brand && (
                      <p className="mt-0.5 truncate text-[11.5px] text-[#7e8c94]">
                        {item.brand}
                      </p>
                    )}
                  </Td>
                  <Td>
                    <Mono>{item.sku}</Mono>
                  </Td>
                  <Td className="text-[#5f7280]">{item.category ?? "—"}</Td>
                  <Td align="right" className="font-semibold">
                    {money(item.effective_price, item.currency)}
                  </Td>
                  <Td align="right">
                    <span className="inline-flex items-center justify-end gap-2">
                      <span className="tnum">{formatNumber(item.stock)}</span>
                      {item.is_low_stock && (
                        <StatusPill
                          size="sm"
                          tone="warning"
                          dot={false}
                          label="Low stock"
                        />
                      )}
                    </span>
                  </Td>
                  <Td align="right" className="text-[#5f7280]">
                    {item.delivery_days === null
                      ? "—"
                      : plural(item.delivery_days, "day")}
                  </Td>
                  <Td align="right" className="text-[#5f7280]">
                    {item.warranty_months === null
                      ? "—"
                      : warrantyTerm(item.warranty_months)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-4 space-y-1.5">
            {missingTerms > 0 && (
              <p className="text-[11.5px] leading-relaxed text-[#b54708]">
                {plural(missingTerms, "item")} here{" "}
                {missingTerms === 1 ? "is" : "are"} missing a delivery or
                warranty term. The scorer imputes a conservative value for a
                missing term rather than dropping the item, then marks the
                resulting quote down on data confidence so the approver can see
                the gap.
              </p>
            )}
            {capped && (
              <p className="text-[11.5px] leading-relaxed text-[#7e8c94]">
                Showing the first {formatNumber(CATALOG_LIMIT)} published items.
                This vendor may list more — the full catalog is browsable from{" "}
                <Link
                  href="/catalog"
                  className="font-semibold text-[#38677b] underline decoration-[#b9d8e1] underline-offset-2 transition-colors duration-200 hover:text-[#447f98]"
                >
                  the catalog screen
                </Link>
                .
              </p>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

/* ==========================================================================
   Page
   ========================================================================== */
type Dialog = { kind: "suspend" } | { kind: "delete" } | null;

export default function VendorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { user } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isAdmin = user?.role === "admin";

  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState("");
  const [deleteConflict, setDeleteConflict] = useState<string | null>(null);

  const vendorQuery = useQuery({
    queryKey: ["vendor", id],
    queryFn: () => api.getVendor(id),
  });

  const catalogQuery = useQuery({
    queryKey: ["vendor-catalog", id],
    queryFn: () => api.browseCatalog({ vendor_id: id, limit: CATALOG_LIMIT }),
    // Only after the vendor itself resolved: no point asking for a catalog
    // belonging to a record the caller may not read.
    enabled: vendorQuery.isSuccess,
    retry: false,
  });

  const vendor = vendorQuery.data;

  const closeDialog = () => {
    setDialog(null);
    setReason("");
    setDeleteConflict(null);
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["vendor", id] });
    void queryClient.invalidateQueries({ queryKey: ["vendors"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "vendors"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "flagged-vendors"] });
  };

  const statusMutation = useMutation({
    mutationFn: (input: { status: VendorStatus; reason?: string }) =>
      api.setVendorStatus(id, input.status, input.reason),
    onSuccess: (updated) => {
      invalidate();
      toast(
        `${updated.name} is now ${VENDOR_STATUS_LABEL[updated.status].toLowerCase()}.`,
        updated.status === "suspended" ? "warning" : "positive",
      );
      closeDialog();
    },
    onError: (error: unknown) => {
      toast(
        error instanceof Error ? error.message : "Could not change that status.",
        "danger",
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteVendor(id),
    onSuccess: () => {
      const name = vendor?.name ?? "Vendor";
      // Drop this vendor's cache rather than invalidating it: an invalidation
      // would refetch a row that no longer exists and flash "this vendor is
      // gone" over the record the administrator just deleted on purpose. The
      // list queries still want refreshing.
      queryClient.removeQueries({ queryKey: ["vendor", id] });
      queryClient.removeQueries({ queryKey: ["vendor-catalog", id] });
      void queryClient.invalidateQueries({ queryKey: ["vendors"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "vendors"] });
      void queryClient.invalidateQueries({
        queryKey: ["admin", "flagged-vendors"],
      });
      toast(`${name} deleted.`, "positive");
      closeDialog();
      router.push("/vendors");
    },
    onError: (error: unknown) => {
      // 409 is the FK guard doing its job, not a fault of ours: keep the
      // dialog open, print what the API said, and offer the alternative.
      if (error instanceof ApiError && error.status === 409) {
        setDeleteConflict(error.message);
        return;
      }
      toast(
        error instanceof Error ? error.message : "Could not delete that vendor.",
        "danger",
      );
    },
  });

  const verifying =
    statusMutation.isPending && statusMutation.variables?.status === "verified";

  const forbidden =
    vendorQuery.error instanceof ApiError && vendorQuery.error.isForbidden;
  const notFound =
    vendorQuery.error instanceof ApiError && vendorQuery.error.isNotFound;

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link
            href="/vendors"
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#7e8c94] transition-colors duration-200 hover:text-[#447f98]"
          >
            <ArrowLeft className="size-3.5" />
            Vendor directory
          </Link>
        }
        title="Vendor record"
        description="The management list shows enough to decide at a glance. This is the view for when that is not enough: the reliability history the scorer actually reads, the open flags behind it, and what this vendor lists."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="size-3.5" />}
            loading={vendorQuery.isFetching || catalogQuery.isFetching}
            onClick={() => {
              void vendorQuery.refetch();
              void catalogQuery.refetch();
            }}
          >
            Refresh
          </Button>
        }
      />

      {vendorQuery.isLoading ? (
        <div className="space-y-5">
          <Skeleton className="h-[190px] rounded-[28px]" />
          <div className="grid gap-5 lg:grid-cols-2">
            <Skeleton className="h-[220px] rounded-[28px]" />
            <Skeleton className="h-[220px] rounded-[28px]" />
          </div>
          <Skeleton className="h-[280px] rounded-[28px]" />
        </div>
      ) : forbidden ? (
        <CalmPanel
          icon={<ShieldOff className="size-6" />}
          title="This record is not yours to read"
        >
          A vendor account may read only its own profile, and the API declined
          this one. That is the same guard that stops one supplier reading a
          competitor&apos;s contact details, terms or performance history.
        </CalmPanel>
      ) : notFound ? (
        <CalmPanel
          icon={<Building2 className="size-6" />}
          title="This vendor is gone"
        >
          Nothing in your organisation matches this identifier. The vendor may
          have been deleted before it was ever quoted, or the link may belong to
          another workspace.
        </CalmPanel>
      ) : vendorQuery.error || !vendor ? (
        <ErrorState
          error={vendorQuery.error}
          onRetry={() => void vendorQuery.refetch()}
        />
      ) : (
        <div className="space-y-5">
          {/* ------------------------------------------------------------
              Identity
              ------------------------------------------------------------ */}
          <Card className="animate-fade-up">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-[26px] font-bold leading-tight tracking-[-0.03em] text-[#243640]">
                  {vendor.name}
                </h2>
                {vendor.legal_name && vendor.legal_name !== vendor.name && (
                  <p className="mt-1 text-[13px] text-[#5f7280]">
                    Registered as {vendor.legal_name}
                  </p>
                )}
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <StatusPill
                    label={VENDOR_STATUS_LABEL[vendor.status]}
                    tone={VENDOR_STATUS_TONE[vendor.status]}
                  />
                  {vendor.category && <Badge tone="brand">{vendor.category}</Badge>}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                  Vendor ID
                </p>
                <div className="mt-1 flex items-center justify-end gap-1.5">
                  <Mono>{vendor.id.slice(0, 8)}…</Mono>
                  <CopyButton value={vendor.id} label="Copy ID" />
                </div>
              </div>
            </div>

            <dl className="mt-5 grid gap-3 border-t border-[#e7eff3] pt-4 sm:grid-cols-3">
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                  Verified
                </dt>
                <dd className="mt-1 text-[13px] font-semibold text-[#243640]">
                  {vendor.verified_at ? (
                    <span title={dateTime(vendor.verified_at)}>
                      {dateOnly(vendor.verified_at)}
                    </span>
                  ) : (
                    <span className="text-[#7e8c94]">
                      Not verified — the agent cannot quote it
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                  On record since
                </dt>
                <dd className="mt-1 text-[13px] font-semibold text-[#243640]">
                  <span title={dateTime(vendor.created_at)}>
                    {dateOnly(vendor.created_at)}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                  Catalog last published
                </dt>
                <dd className="mt-1 text-[13px] font-semibold text-[#243640]">
                  {vendor.last_published_at ? (
                    <span title={dateTime(vendor.last_published_at)}>
                      {relativeTime(vendor.last_published_at)}
                    </span>
                  ) : (
                    <span className="text-[#7e8c94]">Never published</span>
                  )}
                </dd>
              </div>
            </dl>
          </Card>

          {/* ------------------------------------------------------------
              Contact and profile defaults
              ------------------------------------------------------------ */}
          <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
            <Panel
              className="animate-fade-up"
              icon={<Mail className="size-4" />}
              title="Contact"
              description="Where a purchase order goes once an administrator approves it."
              bodyClassName="space-y-2.5"
            >
              <ContactRow
                icon={<Mail className="size-4" />}
                label="Email"
                value={vendor.email}
                href={vendor.email ? `mailto:${vendor.email}` : undefined}
              />
              <ContactRow
                icon={<Phone className="size-4" />}
                label="Phone"
                value={vendor.phone}
                href={
                  vendor.phone ? `tel:${vendor.phone.replace(/\s+/g, "")}` : undefined
                }
              />
              <ContactRow
                icon={<MapPin className="size-4" />}
                label="Address"
                value={vendor.address}
              />
            </Panel>

            <Panel
              className="animate-fade-up"
              icon={<Truck className="size-4" />}
              title="Profile defaults"
              description="The terms this vendor quotes when an individual item says nothing."
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-[18px] bg-white/55 px-4 py-3.5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                    Default delivery
                  </p>
                  <p className="mt-1.5 text-[20px] font-bold leading-none tracking-[-0.02em] text-[#243640] tnum">
                    {vendor.default_delivery_days === null
                      ? "Not set"
                      : plural(vendor.default_delivery_days, "day")}
                  </p>
                </div>
                <div className="rounded-[18px] bg-white/55 px-4 py-3.5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                    Default warranty
                  </p>
                  <p className="mt-1.5 text-[20px] font-bold leading-none tracking-[-0.02em] text-[#243640] tnum">
                    {vendor.default_warranty_months === null
                      ? "Not set"
                      : warrantyTerm(vendor.default_warranty_months)}
                  </p>
                </div>
              </div>
              <p className="mt-4 text-[11.5px] leading-relaxed text-[#7e8c94]">
                New catalog items inherit these two terms, and any item may
                override either one. An item left with neither its own term nor
                a default here counts as a missing term: the scorer imputes a
                conservative value and lowers the data confidence on the quote
                rather than quietly assuming the best case.
              </p>
            </Panel>
          </div>

          {/* ------------------------------------------------------------
              Reliability, flags, catalog
              ------------------------------------------------------------ */}
          <ReliabilityBlock vendor={vendor} />

          <FlagsBlock flags={vendor.flags} />

          <CatalogBlock
            items={catalogQuery.data ?? []}
            // `isPending`, not `isLoading`: this query is gated on the vendor
            // resolving, and a gated query reports isLoading false with no
            // data — which would flash "nothing published" before it asks.
            isLoading={catalogQuery.isPending}
            error={catalogQuery.error}
            onRetry={() => void catalogQuery.refetch()}
          />

          {/* ------------------------------------------------------------
              Administrator actions
              ------------------------------------------------------------ */}
          {isAdmin && (
            <Panel
              className="animate-fade-up"
              icon={<ShieldCheck className="size-4" />}
              title="Administrator actions"
              description="Verification, suspension and reinstatement are administrator acts. Suspending removes the vendor from every future comparison; quotes and purchase orders already recorded are untouched."
            >
              <div className="flex flex-wrap items-center gap-2">
                {vendor.status === "pending" && (
                  <Button
                    variant="primary"
                    icon={<ShieldCheck className="size-4" />}
                    loading={verifying}
                    onClick={() => statusMutation.mutate({ status: "verified" })}
                  >
                    Verify
                  </Button>
                )}
                {vendor.status === "flagged" && (
                  <Button
                    variant="subtle"
                    icon={<ShieldCheck className="size-4" />}
                    loading={verifying}
                    onClick={() => statusMutation.mutate({ status: "verified" })}
                  >
                    Clear flag
                  </Button>
                )}
                {(vendor.status === "verified" || vendor.status === "flagged") && (
                  <Button
                    variant="secondary"
                    icon={<Ban className="size-4" />}
                    onClick={() => {
                      setReason("");
                      setDeleteConflict(null);
                      setDialog({ kind: "suspend" });
                    }}
                  >
                    Suspend
                  </Button>
                )}
                {vendor.status === "suspended" && (
                  <Button
                    variant="subtle"
                    icon={<RotateCcw className="size-4" />}
                    loading={verifying}
                    onClick={() => statusMutation.mutate({ status: "verified" })}
                  >
                    Reinstate
                  </Button>
                )}
                <Button
                  variant="ghost"
                  icon={<Trash2 className="size-4" />}
                  className="text-[#b42318] hover:bg-[#fef3f2] hover:text-[#b42318]"
                  onClick={() => {
                    setDeleteConflict(null);
                    setDialog({ kind: "delete" });
                  }}
                >
                  Delete
                </Button>
              </div>
              <p className="mt-4 text-[11.5px] leading-relaxed text-[#7e8c94]">
                A pending vendor contributes no quotes at all until it is
                verified. A flagged one still reaches the comparison, with the
                flag surfaced in the justification for the approver to weigh —
                only suspension removes it from quoting.
              </p>
            </Panel>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------
          Suspend
          ------------------------------------------------------------------ */}
      <Modal
        open={dialog?.kind === "suspend"}
        onClose={closeDialog}
        title={`Suspend ${vendor?.name ?? "vendor"}?`}
        description="A suspended vendor is removed from every future comparison — the agent will not quote it again until it is reinstated. Quotes and purchase orders already recorded are untouched."
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={statusMutation.isPending}
              icon={<Ban className="size-4" />}
              onClick={() =>
                statusMutation.mutate({
                  status: "suspended",
                  reason: reason.trim() || undefined,
                })
              }
            >
              Suspend vendor
            </Button>
          </>
        }
      >
        <Field
          label="Reason"
          htmlFor="suspend-reason"
          hint="Optional, stored on the vendor record so the next administrator can see why."
        >
          <Textarea
            id="suspend-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Repeated late deliveries on Q3 orders."
          />
        </Field>
      </Modal>

      {/* ------------------------------------------------------------------
          Delete — expected to be refused for any vendor with history
          ------------------------------------------------------------------ */}
      <Modal
        open={dialog?.kind === "delete"}
        onClose={closeDialog}
        title={`Delete ${vendor?.name ?? "vendor"}?`}
        description="Deletion is permanent, and only possible for a vendor that has never been quoted."
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>
              Cancel
            </Button>
            {deleteConflict ? (
              <Button
                variant="danger"
                icon={<Ban className="size-4" />}
                onClick={() => {
                  setDeleteConflict(null);
                  setReason("");
                  setDialog({ kind: "suspend" });
                }}
              >
                Suspend instead
              </Button>
            ) : (
              <Button
                variant="danger"
                loading={deleteMutation.isPending}
                icon={<Trash2 className="size-4" />}
                onClick={() => deleteMutation.mutate()}
              >
                Delete vendor
              </Button>
            )}
          </>
        }
      >
        {deleteConflict ? (
          <Alert tone="warning" title="This vendor has audit history">
            <p>{deleteConflict}</p>
            <p className="mt-2 opacity-90">
              The foreign key from quotes is ON DELETE RESTRICT by design: a
              recorded decision must keep the counterparty it was made against.
              Suspending achieves the same practical outcome — the vendor stops
              appearing in comparisons — while the trail stays intact.
            </p>
          </Alert>
        ) : (
          <Alert tone="neutral" title="What happens next">
            If this vendor appears in any quote or purchase order, the API will
            refuse the deletion rather than break the audit trail. You will be
            offered suspension instead.
          </Alert>
        )}
      </Modal>
    </>
  );
}
