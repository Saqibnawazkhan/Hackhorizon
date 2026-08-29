"use client";

/**
 * The vendor portal's incoming purchase orders.
 *
 * Same claymorphic material as the catalog editor — an opaque, extruded
 * surface rather than the buyer console's glass, so the two halves of the
 * marketplace never blur into each other.
 *
 * What makes this screen more than a list: every status change written here
 * is recorded as a fulfilment event, and the vendor reliability score the
 * buyer side reads is *derived* from those events. On-time rate compares the
 * delivery date recorded here against the expected date on the order;
 * quantity accuracy compares the quantity recorded here against the quantity
 * ordered. Nothing writes a rating directly, which is precisely why a vendor
 * with too few completed orders shows "No history yet" on the buyer side
 * instead of a fabricated number.
 *
 * `PATCH /vendors/me/purchase-orders/{id}/delivery` accepts any status, but
 * the control here follows the real lifecycle — issued → acknowledged →
 * in_transit → delivered — one step at a time, plus a cancellation. Moving to
 * delivered is the only step that carries data (quantity, date, note), so it
 * is the only one that opens a dialog.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Gauge,
  Lock,
  PackageCheck,
  Truck,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Button,
  Card,
  ChipGroup,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Mono,
  StatusPill,
  Td,
  Textarea,
  Th,
  Tr,
  cn,
  useToast,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  DELIVERY_STATUS_LABEL,
  DELIVERY_STATUS_TONE,
  dateOnly,
  dateTime,
  money,
  number,
  parseDate,
  relativeTime,
} from "@/lib/format";
import type { PODeliveryStatus, VendorPurchaseOrder } from "@/lib/types";

const PAGE_SIZE = 10;

/** The real lifecycle. `cancelled` is an exit, not a stage, so it is not here. */
const LIFECYCLE: PODeliveryStatus[] = [
  "issued",
  "acknowledged",
  "in_transit",
  "delivered",
];

const NEXT_STEP: Partial<
  Record<PODeliveryStatus, { next: PODeliveryStatus; label: string; icon: ReactNode }>
> = {
  issued: {
    next: "acknowledged",
    label: "Acknowledge order",
    icon: <ClipboardCheck className="size-4" />,
  },
  acknowledged: {
    next: "in_transit",
    label: "Mark in transit",
    icon: <Truck className="size-4" />,
  },
  in_transit: {
    next: "delivered",
    label: "Mark delivered",
    icon: <PackageCheck className="size-4" />,
  },
};

type StatusFilter = "all" | PODeliveryStatus;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All orders" },
  ...LIFECYCLE.map((value) => ({ value, label: DELIVERY_STATUS_LABEL[value] })),
  { value: "cancelled", label: DELIVERY_STATUS_LABEL.cancelled },
];

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

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function unitsOrdered(po: VendorPurchaseOrder): number {
  return po.line_items.reduce((sum, line) => sum + line.quantity, 0);
}

/** Whole days past the expected date, for an order still in flight. */
function overdueDays(po: VendorPurchaseOrder): number | null {
  if (po.delivery_status === "delivered" || po.delivery_status === "cancelled") {
    return null;
  }
  const expected = parseDate(po.expected_delivery_date);
  if (!expected) return null;
  const days = Math.floor((Date.now() - expected.getTime()) / 86_400_000);
  return days > 0 ? days : null;
}

/* ==========================================================================
   Small pieces
   ========================================================================== */
function Meta({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  tone?: "neutral" | "warning" | "muted";
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
        {label}
      </p>
      <p
        className={cn(
          "tnum mt-0.5 truncate text-[12.5px] font-semibold",
          tone === "warning"
            ? "text-[#b54708]"
            : tone === "muted"
              ? "text-[#9db0ba]"
              : "text-[#2e3e47]",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** The four stages, filled up to where this order has actually reached. */
function LifecycleRail({ status }: { status: PODeliveryStatus }) {
  if (status === "cancelled") {
    return (
      <div className="clay-recess rounded-[18px] px-4 py-2.5">
        <p className="text-[12px] font-medium leading-relaxed text-[#b42318]">
          Cancelled. This order is closed, and the cancellation is counted in your
          reliability record.
        </p>
      </div>
    );
  }
  const reached = LIFECYCLE.indexOf(status);
  return (
    <div className="flex items-end gap-1.5">
      {LIFECYCLE.map((step, index) => {
        const done = index <= reached;
        return (
          <div key={step} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span
              className={cn(
                "h-1.5 rounded-full transition-colors duration-200",
                done ? "gradient-cta" : "bg-[#ddedf4]",
              )}
            />
            <span
              className={cn(
                "truncate text-[10px] font-semibold uppercase tracking-[0.06em]",
                done ? "text-[#38677b]" : "text-[#a3b6c0]",
              )}
            >
              {DELIVERY_STATUS_LABEL[step]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ==========================================================================
   One order
   ========================================================================== */
function OrderCard({
  po,
  busy,
  expanded,
  onToggle,
  onAdvance,
  onDeliver,
  onCancel,
}: {
  po: VendorPurchaseOrder;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onAdvance: (next: PODeliveryStatus) => void;
  onDeliver: () => void;
  onCancel: () => void;
}) {
  const step = NEXT_STEP[po.delivery_status];
  const overdue = overdueDays(po);
  const units = unitsOrdered(po);
  const closed =
    po.delivery_status === "delivered" || po.delivery_status === "cancelled";

  return (
    <Card variant="clay" padded={false} className="animate-fade-up self-start">
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <Mono>{po.po_number}</Mono>
              <CopyButton value={po.po_number} label="Copy" />
            </div>
            <p className="tnum mt-2.5 text-[24px] font-bold leading-none tracking-[-0.03em] text-[#2e3e47]">
              {money(po.total_amount, po.currency)}
            </p>
            <p className="mt-2 text-[12px] text-[#7e8c94]">
              {number(units)} {plural(units, "unit", "units")} across {po.line_items.length}{" "}
              {plural(po.line_items.length, "line", "lines")} · issued{" "}
              {relativeTime(po.created_at)}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <StatusPill
              label={DELIVERY_STATUS_LABEL[po.delivery_status]}
              tone={DELIVERY_STATUS_TONE[po.delivery_status]}
            />
            {overdue !== null && (
              <StatusPill
                label={`Overdue by ${number(overdue)} ${plural(overdue, "day", "days")}`}
                tone="warning"
              />
            )}
          </div>
        </div>

        <div className="clay-recess mt-4 grid grid-cols-2 gap-x-5 gap-y-3 rounded-[20px] px-4 py-3 sm:grid-cols-3">
          <Meta label="Issued" value={dateOnly(po.created_at)} />
          <Meta
            label="Expected"
            value={po.expected_delivery_date ? dateOnly(po.expected_delivery_date) : "Not set"}
            tone={overdue !== null ? "warning" : po.expected_delivery_date ? "neutral" : "muted"}
          />
          <Meta
            label="Delivered"
            value={po.delivered_at ? dateTime(po.delivered_at) : "Not yet"}
            tone={po.delivered_at ? "neutral" : "muted"}
          />
        </div>

        <div className="mt-4">
          <LifecycleRail status={po.delivery_status} />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {step && (
            <Button
              size="sm"
              icon={step.icon}
              loading={busy}
              onClick={() => (step.next === "delivered" ? onDeliver() : onAdvance(step.next))}
            >
              {step.label}
            </Button>
          )}
          {!closed && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Ban className="size-3.5" />}
              disabled={busy}
              onClick={onCancel}
            >
              Cancel order
            </Button>
          )}
          {po.delivery_status === "delivered" && (
            <p className="text-[12px] font-medium text-[#067647]">
              Fulfilment recorded. It now counts toward your on-time rate.
            </p>
          )}

          <button
            type="button"
            onClick={onToggle}
            className="ml-auto inline-flex items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-[12px] font-semibold text-[#5f7280] transition-colors duration-200 hover:bg-[#ddedf4] hover:text-[#2e3e47]"
            aria-expanded={expanded}
          >
            {expanded ? "Hide" : "Show"} line items
            <ChevronDown
              className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-180")}
              aria-hidden
            />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="animate-fade-in border-t border-white/70 px-5 pb-5 pt-4 sm:px-6">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left" style={{ minWidth: 440 }}>
              <thead>
                <Tr>
                  <Th className="w-8">#</Th>
                  <Th>Description</Th>
                  <Th align="right">Qty</Th>
                  <Th align="right">Unit price</Th>
                  <Th align="right">Line total</Th>
                </Tr>
              </thead>
              <tbody>
                {po.line_items.map((line) => (
                  <Tr key={line.line_number}>
                    <Td className="tnum text-[12px] text-[#9db0ba]">{line.line_number}</Td>
                    <Td>
                      <p className="text-[12.5px] font-medium text-[#2e3e47]">
                        {line.description}
                      </p>
                      {line.sku && (
                        <p className="mt-1 font-mono text-[11px] text-[#7e8c94]">{line.sku}</p>
                      )}
                    </Td>
                    <Td align="right" className="text-[12.5px] text-[#4a5c66]">
                      {number(line.quantity)}
                    </Td>
                    <Td align="right" className="text-[12.5px] text-[#4a5c66]">
                      {money(line.unit_price, po.currency)}
                    </Td>
                    <Td align="right" className="text-[12.5px] font-semibold text-[#2e3e47]">
                      {money(line.line_total, po.currency)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ==========================================================================
   Page
   ========================================================================== */
export default function VendorOrdersPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [status, setStatus] = useState<StatusFilter>("all");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [deliverFor, setDeliverFor] = useState<VendorPurchaseOrder | null>(null);
  const [cancelFor, setCancelFor] = useState<VendorPurchaseOrder | null>(null);

  const [quantity, setQuantity] = useState("");
  const [deliveredOn, setDeliveredOn] = useState("");
  const [note, setNote] = useState("");
  const [quantityError, setQuantityError] = useState<string | null>(null);

  // Resetting the offset in an effect would first fire a request for the new
  // filter at the *old* offset — an extra round trip that usually answers with
  // an empty page, flashing the empty state before the real one lands.
  const changeStatus = (next: StatusFilter) => {
    setStatus(next);
    setOffset(0);
  };

  useEffect(() => {
    if (!deliverFor) return;
    setQuantity(String(unitsOrdered(deliverFor)));
    setDeliveredOn("");
    setNote("");
    setQuantityError(null);
  }, [deliverFor]);

  const ordersQuery = useQuery({
    queryKey: ["vendor", "purchase-orders", status, offset],
    queryFn: () =>
      api.myPurchaseOrders({
        status: status === "all" ? undefined : status,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: keepPreviousData,
  });

  const deliveryMutation = useMutation({
    mutationFn: (input: {
      poId: string;
      body: {
        delivery_status: PODeliveryStatus;
        quantity_delivered?: number | null;
        delivered_at?: string | null;
        note?: string | null;
      };
    }) => api.updateDeliveryStatus(input.poId, input.body),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["vendor", "purchase-orders"] });
      toast(
        `${result.po_number} marked ${DELIVERY_STATUS_LABEL[result.delivery_status].toLowerCase()}.`,
      );
      setDeliverFor(null);
      setCancelFor(null);
    },
    onError: (failure) => {
      toast(
        failure instanceof Error ? failure.message : "Could not update this order.",
        "danger",
      );
    },
  });

  const busyId = deliveryMutation.isPending ? deliveryMutation.variables?.poId : null;

  const orders = ordersQuery.data?.items ?? [];
  const total = ordersQuery.data?.total ?? 0;
  const forbidden = ordersQuery.error instanceof ApiError && ordersQuery.error.isForbidden;

  const submitDelivery = (event: FormEvent) => {
    event.preventDefault();
    if (!deliverFor) return;

    const raw = quantity.trim();
    const parsed = Number(raw);
    if (raw === "" || !Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      setQuantityError("Enter the whole number of units you actually delivered.");
      return;
    }
    setQuantityError(null);

    deliveryMutation.mutate({
      poId: deliverFor.id,
      body: {
        delivery_status: "delivered",
        quantity_delivered: parsed,
        // A bare date is sent as an explicit UTC instant, matching the
        // timezone-aware column the backend writes when it defaults to now.
        delivered_at: deliveredOn ? `${deliveredOn}T00:00:00Z` : null,
        note: note.trim() || null,
      },
    });
  };

  const header = (
    <PageHeader
      title="Purchase orders"
      description="Orders the agent has raised against your catalog. Keep their status current — it is what your reliability score is built from."
    />
  );

  /* -- No vendor profile -------------------------------------------------- */
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
                This account has no vendor profile
              </h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[#5f7280]">
                The API answered{" "}
                <span className="font-medium text-[#4a5c66]">
                  &ldquo;no vendor profile is linked to this account&rdquo;
                </span>
                . Purchase orders are scoped to the vendor the signed-in identity owns — never to
                a vendor id sent by the client — so without that link there is nothing to list. An
                administrator links a vendor record to a portal account.
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

      {/* -- Why these updates matter ---------------------------------------- */}
      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card variant="clay" className="animate-fade-up lg:col-span-2">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-[14px] bg-[#ddedf4] text-[#38677b] shadow-[inset_0_2px_5px_rgba(68,127,152,0.22)]">
              <Gauge className="size-4" />
            </span>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#2e3e47]">
              These updates are your reliability score
            </h2>
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-[#5f7280]">
            Each status you set is written as a fulfilment event, and your reliability rating is
            derived from those events — it is never entered by hand, by you or by anyone else.
            That is also why the buyer side says{" "}
            <strong className="font-semibold text-[#2e3e47]">&ldquo;No history yet&rdquo;</strong>{" "}
            for a vendor with too few completed orders, rather than inventing a rating: with no
            real fulfilment to measure, there is honestly nothing to report. Reliability is one of
            the four weighted criteria the agent scores every quote on, so keeping this list
            current is the most direct way to compete on something other than price.
          </p>
        </Card>

        <Card variant="clay" className="animate-fade-up">
          <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            What each field feeds
          </p>
          <div className="mt-3 space-y-2.5">
            <div className="clay-recess rounded-[18px] px-4 py-3">
              <p className="text-[12.5px] font-semibold text-[#2e3e47]">On-time rate</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#5f7280]">
                The delivery date you record, compared with the expected date on the order.
              </p>
            </div>
            <div className="clay-recess rounded-[18px] px-4 py-3">
              <p className="text-[12.5px] font-semibold text-[#2e3e47]">Quantity accuracy</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#5f7280]">
                The quantity you record, compared with the quantity ordered across all lines.
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* -- Filter ----------------------------------------------------------- */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ChipGroup options={STATUS_OPTIONS} value={status} onChange={changeStatus} />
        {total > 0 && (
          <p className="tnum text-[12px] font-semibold text-[#7e8c94]">
            {number(total)} {plural(total, "order", "orders")}
          </p>
        )}
      </div>

      {/* -- The orders ------------------------------------------------------- */}
      {ordersQuery.isLoading ? (
        <Card variant="clay" className="animate-fade-up">
          <LoadingBlock rows={4} />
        </Card>
      ) : ordersQuery.error ? (
        <Card variant="clay" className="animate-fade-up">
          <ErrorState error={ordersQuery.error} onRetry={() => void ordersQuery.refetch()} />
        </Card>
      ) : orders.length === 0 ? (
        <Card variant="clay" className="animate-fade-up">
          {offset > 0 ? (
            // Past the end of the list — orders moved out from under this page.
            // Saying "no orders" here would be a claim about the whole queue.
            <EmptyState
              icon={<Truck className="size-6" />}
              title="Nothing left on this page"
              description="These orders changed while you were reading them. Everything still in your queue is on the earlier pages."
              action={
                <Button variant="secondary" onClick={() => setOffset(0)}>
                  Back to the first page
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Truck className="size-6" />}
              title={
                status === "all"
                  ? "No purchase orders yet"
                  : `No ${DELIVERY_STATUS_LABEL[status].toLowerCase()} orders`
              }
              description={
                status === "all"
                  ? "An order appears here once a buyer's workflow selects your quote and an administrator approves the purchase order. The agent never commits one on its own."
                  : "Nothing in your queue is at this stage right now. Try another filter."
              }
              action={
                status === "all" ? undefined : (
                  <Button variant="secondary" onClick={() => changeStatus("all")}>
                    Show all orders
                  </Button>
                )
              }
            />
          )}
        </Card>
      ) : (
        <>
          <div className="grid items-start gap-4 xl:grid-cols-2">
            {orders.map((po) => (
              <OrderCard
                key={po.id}
                po={po}
                busy={busyId === po.id}
                expanded={Boolean(expanded[po.id])}
                onToggle={() =>
                  setExpanded((previous) => ({ ...previous, [po.id]: !previous[po.id] }))
                }
                onAdvance={(next) =>
                  deliveryMutation.mutate({ poId: po.id, body: { delivery_status: next } })
                }
                onDeliver={() => setDeliverFor(po)}
                onCancel={() => setCancelFor(po)}
              />
            ))}
          </div>

          {total > PAGE_SIZE && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <p className="tnum text-[12px] text-[#7e8c94]">
                Showing {number(offset + 1)}–{number(Math.min(offset + PAGE_SIZE, total))} of{" "}
                {number(total)}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ChevronLeft className="size-3.5" />}
                  disabled={offset === 0}
                  onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  iconRight={<ChevronRight className="size-3.5" />}
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset((value) => value + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* -- Mark delivered ---------------------------------------------------- */}
      <Modal
        open={deliverFor !== null}
        onClose={() => setDeliverFor(null)}
        width={560}
        title="Record this delivery"
        description="These two numbers are what your on-time rate and quantity accuracy are computed from."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setDeliverFor(null)}
              disabled={deliveryMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="deliver-form"
              variant="success"
              loading={deliveryMutation.isPending}
              icon={<PackageCheck className="size-4" />}
            >
              Mark delivered
            </Button>
          </>
        }
      >
        {deliverFor && (
          <form id="deliver-form" onSubmit={submitDelivery} className="space-y-4 pb-4">
            <div className="clay-recess flex flex-wrap items-center justify-between gap-3 rounded-[18px] px-4 py-3">
              <div className="flex items-center gap-2">
                <Mono>{deliverFor.po_number}</Mono>
                <span className="tnum text-[12.5px] font-semibold text-[#2e3e47]">
                  {money(deliverFor.total_amount, deliverFor.currency)}
                </span>
              </div>
              <span className="tnum text-[11.5px] text-[#5f7280]">
                {number(unitsOrdered(deliverFor))} {plural(unitsOrdered(deliverFor), "unit", "units")}{" "}
                ordered
              </span>
            </div>

            <Field
              label="Quantity delivered"
              required
              htmlFor="deliver-quantity"
              error={quantityError}
              hint={
                quantityError
                  ? undefined
                  : "Prefilled with the quantity ordered. Change it if you shipped short."
              }
            >
              <Input
                id="deliver-quantity"
                inputMode="numeric"
                value={quantity}
                aria-invalid={Boolean(quantityError)}
                onChange={(event) => {
                  setQuantity(event.target.value);
                  setQuantityError(null);
                }}
                className={cn(CLAY_FIELD, "tnum", quantityError && INVALID_FIELD)}
              />
            </Field>

            <Field
              label="Delivered on"
              htmlFor="deliver-date"
              hint={
                deliverFor.expected_delivery_date
                  ? `Leave blank to record now. This order was expected by ${dateOnly(deliverFor.expected_delivery_date)}.`
                  : "Leave blank to record now."
              }
            >
              <Input
                id="deliver-date"
                type="date"
                value={deliveredOn}
                onChange={(event) => setDeliveredOn(event.target.value)}
                className={CLAY_FIELD}
              />
            </Field>

            <Field
              label="Note"
              htmlFor="deliver-note"
              hint="Optional. Stored with the fulfilment event — useful when the quantity or the date needs an explanation."
            >
              <Textarea
                id="deliver-note"
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Two units back-ordered; balance shipped separately."
                className={cn(CLAY_FIELD, "min-h-[84px]")}
              />
            </Field>
          </form>
        )}
      </Modal>

      {/* -- Cancel ------------------------------------------------------------ */}
      <Modal
        open={cancelFor !== null}
        onClose={() => setCancelFor(null)}
        width={470}
        title="Cancel this order?"
        description="The buyer is left without the goods, and the cancellation is recorded against your reliability."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setCancelFor(null)}
              disabled={deliveryMutation.isPending}
            >
              Keep the order
            </Button>
            <Button
              variant="danger"
              loading={deliveryMutation.isPending}
              icon={<Ban className="size-4" />}
              onClick={() => {
                if (cancelFor) {
                  deliveryMutation.mutate({
                    poId: cancelFor.id,
                    body: { delivery_status: "cancelled" },
                  });
                }
              }}
            >
              Cancel order
            </Button>
          </>
        }
      >
        {cancelFor && (
          <div className="clay-recess mb-4 rounded-[18px] px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Mono>{cancelFor.po_number}</Mono>
              <span className="tnum text-[12.5px] font-semibold text-[#2e3e47]">
                {money(cancelFor.total_amount, cancelFor.currency)}
              </span>
            </div>
            <p className="mt-1.5 text-[11.5px] text-[#5f7280]">
              {number(unitsOrdered(cancelFor))}{" "}
              {plural(unitsOrdered(cancelFor), "unit", "units")} across{" "}
              {cancelFor.line_items.length}{" "}
              {plural(cancelFor.line_items.length, "line", "lines")}
              {cancelFor.expected_delivery_date
                ? ` · expected ${dateOnly(cancelFor.expected_delivery_date)}`
                : ""}
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
