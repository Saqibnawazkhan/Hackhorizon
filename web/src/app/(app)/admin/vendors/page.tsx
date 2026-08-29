"use client";

/**
 * Vendor governance — design screen 18a.
 *
 * The administrator's view of the supplier base: who the agent may quote
 * from, what the monitor has flagged, and the state transitions only an admin
 * can make. Two backend facts shape the copy here:
 *
 *  - A flag is a warning, not a ban. `selectable_for_quoting` includes
 *    FLAGGED vendors and excludes only SUSPENDED ones, so a flagged supplier
 *    still reaches the comparison — with its flag surfaced in the
 *    justification for the approver to weigh.
 *  - Deletion is refused once the vendor appears in a quote. The foreign key
 *    is ON DELETE RESTRICT precisely so audit history can never lose its
 *    counterparty; the API answers 409 and this screen offers suspension
 *    instead of presenting that as a fault.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Badge,
  Button,
  ChipGroup,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  LoadingBlock,
  Modal,
  Mono,
  Panel,
  Skeleton,
  StatusPill,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
  useToast,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  VENDOR_STATUS_LABEL,
  VENDOR_STATUS_TONE,
  humanise,
  number as formatNumber,
  percent,
  relativeTime,
} from "@/lib/format";
import type { Vendor, VendorStatus } from "@/lib/types";

const PAGE_SIZE = 20;

type StatusFilter = VendorStatus | "all";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending review" },
  { value: "verified", label: "Verified" },
  { value: "flagged", label: "Flagged" },
  { value: "suspended", label: "Suspended" },
];

/** The prose name for each flag reason the monitor can raise. */
const FLAG_LABEL: Record<string, string> = {
  late_deliveries: "Late deliveries",
  low_on_time_rate: "Low on-time rate",
  cancellations: "Cancellations",
  quantity_shortfall: "Quantity shortfall",
};

/** What each automatic flag means, in the monitor's own terms. */
const FLAG_EXPLANATION: Record<string, string> = {
  late_deliveries:
    "Deliveries arrived after the expected date more often than the configured tolerance.",
  low_on_time_rate:
    "The share of orders delivered on time fell below the configured floor.",
  cancellations: "The vendor cancelled more orders than the configured limit.",
  quantity_shortfall:
    "Delivered quantities fell short of what the purchase order specified.",
};

type Dialog =
  | { kind: "suspend"; vendor: Vendor }
  | { kind: "delete"; vendor: Vendor }
  | null;

export default function AdminVendorsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [status, setStatus] = useState<StatusFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState("");
  const [deleteConflict, setDeleteConflict] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const vendorsQuery = useQuery({
    queryKey: ["admin", "vendors", status, search, offset],
    queryFn: () =>
      api.listVendors({
        status: status === "all" ? undefined : status,
        search: search || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
  });

  const flaggedQuery = useQuery({
    queryKey: ["admin", "flagged-vendors"],
    queryFn: () => api.flaggedVendors(),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "vendors"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "flagged-vendors"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "dashboard"] });
  };

  const closeDialog = () => {
    setDialog(null);
    setReason("");
    setDeleteConflict(null);
  };

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; status: VendorStatus; reason?: string }) =>
      api.setVendorStatus(input.id, input.status, input.reason),
    onSuccess: (vendor) => {
      invalidate();
      toast(
        `${vendor.name} is now ${VENDOR_STATUS_LABEL[vendor.status].toLowerCase()}.`,
        vendor.status === "suspended" ? "warning" : "positive",
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
    mutationFn: (id: string) => api.deleteVendor(id),
    onSuccess: () => {
      const name = dialog?.vendor.name ?? "Vendor";
      invalidate();
      toast(`${name} deleted.`, "positive");
      closeDialog();
    },
    onError: (error: unknown) => {
      // 409 is the FK guard, not a failure of ours: keep the dialog open and
      // explain the alternative the API itself suggests.
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

  const busyVendorId =
    statusMutation.isPending ? statusMutation.variables?.id : undefined;

  const vendors = vendorsQuery.data?.items ?? [];
  const total = vendorsQuery.data?.total ?? 0;
  const filtered = status !== "all" || search.length > 0;
  const flags = flaggedQuery.data ?? [];

  const rangeLabel = useMemo(() => {
    if (total === 0) return null;
    const first = offset + 1;
    const last = offset + vendors.length;
    return `${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(total)}`;
  }, [offset, total, vendors.length]);

  return (
    <>
      <PageHeader
        title="Vendor governance"
        description="Verification, suspension and reinstatement for every supplier the agent is allowed to quote from. Only verified and flagged vendors reach a comparison — pending and suspended ones never do, and a flag is a warning for you rather than an automatic ban."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="size-3.5" />}
            onClick={() => {
              void vendorsQuery.refetch();
              void flaggedQuery.refetch();
            }}
            loading={vendorsQuery.isFetching || flaggedQuery.isFetching}
          >
            Refresh
          </Button>
        }
      />

      {/* ------------------------------------------------------------------
          Flags raised by the monitor
          ------------------------------------------------------------------ */}
      <Panel
        className="animate-fade-up mb-4"
        icon={<ShieldAlert className="size-4" />}
        title={
          <span className="flex items-center gap-2">
            Flagged by the monitor
            {flags.length > 0 && (
              <Badge tone="danger">{formatNumber(flags.length)} open</Badge>
            )}
          </span>
        }
        description="Raised automatically from fulfilment history against the configured thresholds — late deliveries, on-time rate, cancellations and quantity shortfall. No one filed these; the scanner derived them from delivered orders, and only the scanner resolves one — returning a vendor to verified leaves its flag standing here."
      >
        {flaggedQuery.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : flaggedQuery.error ? (
          <ErrorState
            error={flaggedQuery.error}
            onRetry={() => void flaggedQuery.refetch()}
          />
        ) : flags.length === 0 ? (
          <EmptyState
            className="py-8"
            icon={<ShieldCheck className="size-6" />}
            title="No open flags"
            description="Every vendor is inside the configured performance thresholds. New flags appear here the moment the scanner raises one."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {flags.map((flag) => (
              <article
                key={`${flag.vendor_id}-${flag.reason}-${flag.raised_at}`}
                className="glass-flat animate-fade-up rounded-[20px] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="truncate text-[13.5px] font-semibold text-[#243640]">
                    <Link
                      href={`/vendors/${flag.vendor_id}`}
                      className="transition-colors hover:text-[#447f98]"
                    >
                      {flag.vendor_name}
                    </Link>
                  </p>
                  <StatusPill
                    size="sm"
                    label={VENDOR_STATUS_LABEL[flag.vendor_status]}
                    tone={VENDOR_STATUS_TONE[flag.vendor_status]}
                  />
                </div>
                <p className="mt-2 text-[12.5px] font-semibold text-[#b42318]">
                  {FLAG_LABEL[flag.reason] ?? humanise(flag.reason)}
                </p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-[#5f7280]">
                  {flag.detail}
                </p>
                {FLAG_EXPLANATION[flag.reason] && (
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#7e8c94]">
                    {FLAG_EXPLANATION[flag.reason]}
                  </p>
                )}
                <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#e7eff3] pt-2.5">
                  <span className="truncate text-[11px] text-[#7e8c94]">
                    Threshold <Mono>{flag.threshold}</Mono>
                  </span>
                  <span
                    className="shrink-0 text-[11px] text-[#7e8c94]"
                    title={flag.raised_at}
                  >
                    {relativeTime(flag.raised_at)}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      {/* ------------------------------------------------------------------
          The register
          ------------------------------------------------------------------ */}
      <Panel
        className="animate-fade-up"
        title={
          <span className="flex items-center gap-2">
            Vendor register
            {total > 0 && (
              <span className="text-[12px] font-medium text-[#7e8c94] tnum">
                {formatNumber(total)}
              </span>
            )}
          </span>
        }
        description="Employees may add a vendor; it lands pending until an administrator verifies it here. A vendor that has never published a catalog has nothing for the agent to quote."
        bodyClassName="pt-4"
        actions={
          <div className="relative w-full sm:w-[240px]">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#a9bac3]" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search by name"
              aria-label="Search vendors by name"
              className="h-10 pl-10 pr-9"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-[8px] text-[#a9bac3] transition-colors hover:bg-white hover:text-[#5f7280]"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        }
      >
        <ChipGroup
          className="mb-4"
          options={STATUS_FILTERS}
          value={status}
          onChange={(next) => {
            setStatus(next);
            setOffset(0);
          }}
        />

        {vendorsQuery.isLoading ? (
          <LoadingBlock rows={5} />
        ) : vendorsQuery.error ? (
          <ErrorState
            error={vendorsQuery.error}
            onRetry={() => void vendorsQuery.refetch()}
          />
        ) : vendors.length === 0 ? (
          <EmptyState
            icon={<Users className="size-6" />}
            title={filtered ? "No vendors match this filter" : "No vendors yet"}
            description={
              filtered
                ? "Nothing in the register matches the current status and search."
                : "Vendors added by employees land here as pending review. Verify one and the agent may begin quoting from its catalog."
            }
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setStatus("all");
                    setSearchInput("");
                    setOffset(0);
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table minWidth={1080}>
              <thead>
                <tr>
                  <Th>Vendor</Th>
                  <Th>Status</Th>
                  <Th>Category</Th>
                  <Th align="right">Catalog published</Th>
                  <Th align="right">Reliability</Th>
                  <Th align="right">Orders</Th>
                  <Th align="right">On time</Th>
                  <Th align="right">Flags</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((vendor) => {
                  const busy = busyVendorId === vendor.id;
                  return (
                    <Tr key={vendor.id}>
                      <Td>
                        {/* This table shows enough to decide verify/suspend at
                            a glance. The name opens the full record for when
                            that is not enough. */}
                        <p className="font-semibold text-[#243640]">
                          <Link
                            href={`/vendors/${vendor.id}`}
                            className="transition-colors hover:text-[#447f98]"
                          >
                            {vendor.name}
                          </Link>
                        </p>
                        <p className="mt-0.5 truncate text-[11.5px] text-[#7e8c94]">
                          {vendor.email ?? vendor.legal_name ?? "No contact on file"}
                        </p>
                      </Td>
                      <Td>
                        <StatusPill
                          size="sm"
                          label={VENDOR_STATUS_LABEL[vendor.status]}
                          tone={VENDOR_STATUS_TONE[vendor.status]}
                        />
                      </Td>
                      <Td className="text-[#5f7280]">{vendor.category ?? "—"}</Td>
                      <Td align="right" className="text-[#5f7280]">
                        {vendor.last_published_at ? (
                          <span title={vendor.last_published_at}>
                            {relativeTime(vendor.last_published_at)}
                          </span>
                        ) : (
                          <span className="text-[11.5px] text-[#7e8c94]">
                            Never
                          </span>
                        )}
                      </Td>
                      <Td align="right">
                        <span
                          className={
                            vendor.reliability.has_history
                              ? "font-semibold text-[#243640]"
                              : "text-[11.5px] text-[#7e8c94]"
                          }
                        >
                          {vendor.reliability.display}
                        </span>
                      </Td>
                      <Td align="right" className="text-[#5f7280]">
                        {formatNumber(vendor.reliability.orders_fulfilled)}
                      </Td>
                      <Td align="right" className="text-[#5f7280]">
                        {percent(vendor.reliability.on_time_rate)}
                      </Td>
                      <Td align="right">
                        {vendor.flags.length > 0 ? (
                          <span
                            className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#b42318]"
                            title={vendor.flags.map((f) => f.detail).join(" · ")}
                          >
                            <AlertTriangle className="size-3.5" />
                            {formatNumber(vendor.flags.length)}
                          </span>
                        ) : (
                          <span className="text-[#b3c4cc]">—</span>
                        )}
                      </Td>
                      <Td align="right">
                        <div className="flex items-center justify-end gap-1.5">
                          {vendor.status === "pending" && (
                            <Button
                              size="sm"
                              variant="subtle"
                              loading={busy}
                              icon={<ShieldCheck className="size-3.5" />}
                              onClick={() =>
                                statusMutation.mutate({
                                  id: vendor.id,
                                  status: "verified",
                                })
                              }
                            >
                              Verify
                            </Button>
                          )}
                          {vendor.status === "flagged" && (
                            <Button
                              size="sm"
                              variant="subtle"
                              loading={busy}
                              icon={<ShieldCheck className="size-3.5" />}
                              title="Returns the vendor to verified. The flag itself stays on the record — only the monitor resolves one."
                              onClick={() =>
                                statusMutation.mutate({
                                  id: vendor.id,
                                  status: "verified",
                                })
                              }
                            >
                              Mark verified
                            </Button>
                          )}
                          {(vendor.status === "verified" ||
                            vendor.status === "flagged") && (
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={<Ban className="size-3.5" />}
                              onClick={() => {
                                setReason("");
                                setDeleteConflict(null);
                                setDialog({ kind: "suspend", vendor });
                              }}
                            >
                              Suspend
                            </Button>
                          )}
                          {vendor.status === "suspended" && (
                            <Button
                              size="sm"
                              variant="subtle"
                              loading={busy}
                              icon={<RotateCcw className="size-3.5" />}
                              onClick={() =>
                                statusMutation.mutate({
                                  id: vendor.id,
                                  status: "verified",
                                })
                              }
                            >
                              Reinstate
                            </Button>
                          )}
                          <IconButton
                            label={`Delete ${vendor.name}`}
                            icon={<Trash2 className="size-4" />}
                            className="text-[#b42318] hover:bg-[#fef3f2] hover:text-[#b42318]"
                            onClick={() => {
                              setDeleteConflict(null);
                              setDialog({ kind: "delete", vendor });
                            }}
                          />
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>

            {total > PAGE_SIZE && (
              <div className="mt-4 flex items-center justify-between gap-3">
                <p className="text-[12px] text-[#7e8c94] tnum">{rangeLabel}</p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={offset + vendors.length >= total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Panel>

      {/* ------------------------------------------------------------------
          Suspend
          ------------------------------------------------------------------ */}
      <Modal
        open={dialog?.kind === "suspend"}
        onClose={closeDialog}
        title={`Suspend ${dialog?.vendor.name ?? "vendor"}?`}
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
              onClick={() => {
                if (dialog?.kind !== "suspend") return;
                statusMutation.mutate({
                  id: dialog.vendor.id,
                  status: "suspended",
                  reason: reason.trim() || undefined,
                });
              }}
            >
              Suspend vendor
            </Button>
          </>
        }
      >
        <Field
          label="Reason"
          hint="Optional, stored on the vendor record so the next administrator can see why."
        >
          <Textarea
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
        title={`Delete ${dialog?.vendor.name ?? "vendor"}?`}
        description="Deletion is permanent and only possible for a vendor that has never been quoted."
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
                  if (dialog?.kind !== "delete") return;
                  const vendor = dialog.vendor;
                  setDeleteConflict(null);
                  setReason("");
                  setDialog({ kind: "suspend", vendor });
                }}
              >
                Suspend instead
              </Button>
            ) : (
              <Button
                variant="danger"
                loading={deleteMutation.isPending}
                icon={<Trash2 className="size-4" />}
                onClick={() => {
                  if (dialog?.kind !== "delete") return;
                  deleteMutation.mutate(dialog.vendor.id);
                }}
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
