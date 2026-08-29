"use client";

/**
 * Spend by vendor.
 *
 * The API groups every purchase order raised in the window by vendor and sorts
 * the result descending. It counts orders as they are *raised*, not as they are
 * paid — an order still parked at the approval gate is already in this total,
 * which is the honest reading of "committed spend" and is said plainly on the
 * page rather than left for someone to discover.
 *
 * The bar chart is hand-built from two divs per row. A charting library would
 * add 40kB to render a dozen rectangles, and would not know that a vendor the
 * monitor has never measured must read "No history yet" instead of 0%.
 */
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BarChart3,
  Building2,
  CalendarRange,
  Receipt,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Button,
  Card,
  ChipGroup,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Panel,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { asNumber, dateOnly, dateTime, money, number, percent } from "@/lib/format";
import type { SpendByVendor } from "@/lib/types";

type Period = "7" | "30" | "90" | "365";

const PERIODS: { value: Period; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "12 months" },
];

/** The chart shows the biggest twelve; the table below stays complete. */
const CHART_ROWS = 12;

export default function SpendReportPage() {
  const router = useRouter();
  const [period, setPeriod] = useState<Period>("30");
  const days = Number(period);

  const spend = useQuery({
    queryKey: ["admin", "spend", days],
    queryFn: () => api.getSpendReport(days),
  });

  const forbidden = spend.error instanceof ApiError && spend.error.isForbidden;

  /* ---------------------------------------------------------------------
     403 — a valid session that simply is not an administrator.
     --------------------------------------------------------------------- */
  if (forbidden) {
    return (
      <>
        <PageHeader
          title="Spend report"
          description="Committed purchase-order value, grouped by vendor."
        />
        <Card className="max-w-2xl animate-fade-up">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-[16px] bg-[#e9f3f8] text-[#38677b]">
              <ShieldCheck className="size-5" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
                This area requires the administrator role
              </h2>
              <p className="mt-2 text-[13px] leading-relaxed text-[#5f7280]">
                Organisation-wide spend is visible to administrators only, and
                the API enforces that server-side. Your own requests and their
                purchase orders are still yours to read.
              </p>
              <div className="mt-5">
                <Button
                  size="sm"
                  onClick={() => router.push("/workflows")}
                  iconRight={<ArrowRight className="size-3.5" />}
                >
                  My workflows
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </>
    );
  }

  const report = spend.data;

  /* Sort defensively — the API already sorts, but a chart that silently
     depends on someone else's ORDER BY is a chart waiting to mislead. */
  const vendors: SpendByVendor[] = report
    ? [...report.by_vendor].sort(
        (a, b) => (asNumber(b.total_spend) ?? 0) - (asNumber(a.total_spend) ?? 0),
      )
    : [];

  const largest = asNumber(vendors[0]?.total_spend) ?? 0;
  const totalSpend = asNumber(report?.total_spend) ?? 0;
  const charted = vendors.slice(0, CHART_ROWS);
  const hidden = vendors.length - charted.length;

  const periodLabel =
    PERIODS.find((option) => option.value === period)?.label ?? `${days} days`;

  return (
    <>
      <PageHeader
        title="Spend report"
        description="Committed purchase-order value by vendor. An order counts from the moment the agent raises it — including one still waiting at the approval gate."
        actions={
          <ChipGroup options={PERIODS} value={period} onChange={setPeriod} />
        }
      />

      <div className="space-y-6">
        {/* ================================================================
            Header figures
            ================================================================ */}
        {spend.error ? (
          <ErrorState error={spend.error} onRetry={() => void spend.refetch()} />
        ) : spend.isLoading || !report ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-[130px] rounded-[28px]" />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Total spend"
              value={money(report.total_spend, report.currency)}
              sub={`Across the last ${periodLabel.toLowerCase()}`}
              tone="brand"
              icon={<Wallet className="size-[18px]" strokeWidth={2} />}
              className="animate-fade-up"
            />
            <StatTile
              label="Purchase orders"
              value={number(report.order_count)}
              sub="Raised in this window"
              icon={<Receipt className="size-[18px]" strokeWidth={2} />}
              className="animate-fade-up"
            />
            <StatTile
              label="Vendors"
              value={number(vendors.length)}
              sub={
                vendors.length === 1
                  ? "One supplier received an order"
                  : "Suppliers that received an order"
              }
              icon={<Building2 className="size-[18px]" strokeWidth={2} />}
              className="animate-fade-up"
            />
            <StatTile
              label="Period"
              value={
                <span className="block text-[14.5px] font-semibold leading-snug tracking-normal">
                  {dateOnly(report.period_start)}
                  <span className="px-1.5 text-[#a9bac3]">→</span>
                  {dateOnly(report.period_end)}
                </span>
              }
              sub="Purchase-order creation date"
              icon={<CalendarRange className="size-[18px]" strokeWidth={2} />}
              className="animate-fade-up"
            />
          </div>
        )}

        {/* ================================================================
            The chart and the table
            ================================================================ */}
        {spend.isLoading ? (
          <Panel title="Spend by vendor">
            <LoadingBlock rows={4} />
          </Panel>
        ) : !report || spend.error ? null : vendors.length === 0 ? (
          <Panel
            title="Spend by vendor"
            icon={<BarChart3 className="size-4" strokeWidth={2.2} />}
          >
            <EmptyState
              icon={<Receipt className="size-6" strokeWidth={1.8} />}
              title="No purchase orders in this period"
              description={`Nothing was raised between ${dateOnly(
                report.period_start,
              )} and ${dateOnly(
                report.period_end,
              )}. A purchase order appears here as soon as the agent generates one — approved or still at the gate.`}
              action={
                period === "365" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => router.push("/requests/new")}
                  >
                    Start a request
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setPeriod("365")}
                  >
                    Look at the last 12 months
                  </Button>
                )
              }
            />
          </Panel>
        ) : (
          <>
            <Panel
              className="animate-fade-up"
              icon={<BarChart3 className="size-4" strokeWidth={2.2} />}
              title="Where the money went"
              description={
                largest > 0
                  ? "Bars are scaled against the largest vendor in this period, so the top bar is always full width."
                  : "Every purchase order in this period totals zero, so there is no largest vendor to scale against and the bars stay empty. The order counts below are still real."
              }
            >
              <ul className="space-y-4">
                {charted.map((vendor, index) => {
                  const value = asNumber(vendor.total_spend) ?? 0;
                  const raw = largest > 0 ? (value / largest) * 100 : 0;
                  // A vendor with a real but tiny amount still gets a sliver,
                  // so "small" never renders as "none".
                  const width = value > 0 ? Math.max(raw, 1.5) : 0;
                  const share = totalSpend > 0 ? value / totalSpend : null;
                  return (
                    <li
                      key={vendor.vendor_id}
                      className="animate-fade-up"
                      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
                    >
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="truncate text-[13px] font-semibold text-[#243640]">
                          {vendor.vendor_name}
                        </span>
                        <span className="tnum shrink-0 text-[13px] font-semibold text-[#243640]">
                          {money(vendor.total_spend, report.currency)}
                        </span>
                      </div>
                      <div
                        className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-[#e7eff3]"
                        aria-hidden
                      >
                        <div
                          className="gradient-cta h-full rounded-full transition-[width] duration-700 ease-out"
                          style={{ width: `${width}%` }}
                        />
                      </div>
                      <p className="tnum mt-1.5 text-[11.5px] text-[#7e8c94]">
                        {number(vendor.order_count)}{" "}
                        {vendor.order_count === 1 ? "order" : "orders"}
                        {share !== null && (
                          <>
                            <span aria-hidden> · </span>
                            {percent(share, 1)} of total
                          </>
                        )}
                      </p>
                    </li>
                  );
                })}
              </ul>

              {hidden > 0 && (
                <p className="tnum mt-5 border-t border-[#eef4f7] pt-4 text-[12px] leading-relaxed text-[#7e8c94]">
                  Charting the {number(charted.length)} largest vendors of{" "}
                  {number(vendors.length)}. {number(hidden)} smaller{" "}
                  {hidden === 1 ? "vendor is" : "vendors are"} not drawn above —
                  every one of them is listed in the table below.
                </p>
              )}
            </Panel>

            <Panel
              className="animate-fade-up"
              icon={<Building2 className="size-4" strokeWidth={2.2} />}
              title="Vendor breakdown"
              description="On-time rate is computed from delivered purchase orders only. A vendor the monitor has not measured yet reads “No history yet” rather than 0% — an unmeasured rate is never imputed."
            >
              <Table minWidth={720}>
                <thead>
                  <tr>
                    <Th>Vendor</Th>
                    <Th align="right">Orders</Th>
                    <Th align="right">Total spend</Th>
                    <Th align="right">On-time</Th>
                    <Th align="right">Share of total</Th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((vendor) => {
                    const value = asNumber(vendor.total_spend) ?? 0;
                    const share = totalSpend > 0 ? value / totalSpend : null;
                    return (
                      <Tr key={vendor.vendor_id}>
                        <Td className="font-semibold">{vendor.vendor_name}</Td>
                        <Td align="right">{number(vendor.order_count)}</Td>
                        <Td align="right" className="font-semibold">
                          {money(vendor.total_spend, report.currency)}
                        </Td>
                        <Td align="right">
                          {vendor.on_time_rate === null ? (
                            <span className="text-[12px] text-[#7e8c94]">
                              No history yet
                            </span>
                          ) : (
                            percent(vendor.on_time_rate)
                          )}
                        </Td>
                        <Td align="right" className="text-[#5f7280]">
                          {share === null ? "—" : percent(share, 1)}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <Td className="border-b-0 border-t border-[#e0ebf0] text-[12px] font-semibold uppercase tracking-[0.06em] text-[#7e8c94]">
                      Total
                    </Td>
                    <Td
                      align="right"
                      className="border-b-0 border-t border-[#e0ebf0] font-semibold"
                    >
                      {number(report.order_count)}
                    </Td>
                    <Td
                      align="right"
                      className="border-b-0 border-t border-[#e0ebf0] font-bold"
                    >
                      {money(report.total_spend, report.currency)}
                    </Td>
                    <Td className="border-b-0 border-t border-[#e0ebf0]" />
                    <Td
                      align="right"
                      className="border-b-0 border-t border-[#e0ebf0] text-[#7e8c94]"
                    >
                      {totalSpend > 0 ? "100.0%" : "—"}
                    </Td>
                  </tr>
                </tfoot>
              </Table>
            </Panel>
          </>
        )}

        {report && (
          <p className="px-1 text-[12px] text-[#7e8c94]">
            Report generated {dateTime(report.generated_at)}. Amounts in{" "}
            {report.currency}.
          </p>
        )}
      </div>
    </>
  );
}
