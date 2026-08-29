"use client";

/**
 * Screen 13a — the buyer-side vendor directory.
 *
 * This is the supply side of the agent's world: the set of companies it is
 * allowed to ask for a price. That permission is not cosmetic. The quoting
 * repository selects vendors whose status is `verified` or `flagged` and
 * nothing else, so a vendor sitting in "Pending review" contributes no quotes
 * at all until an administrator verifies it. A flag, by contrast, is a warning
 * carried into the approval justification rather than an automatic ban — the
 * human decides.
 *
 * The reliability block is the other thing worth being careful about. The API
 * hands back a pre-rendered `display` string precisely so that no client can
 * invent a rating: below the configured minimum of fulfilled orders it reads
 * "No history yet", and the scorer falls back to a neutral sub-score instead of
 * guessing. We print that string verbatim.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BadgeCheck,
  Building2,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Mail,
  MapPin,
  Phone,
  Plus,
  Search,
  ShieldCheck,
  Truck,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  ChipGroup,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Skeleton,
  StatusPill,
  cn,
  useToast,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  VENDOR_STATUS_LABEL,
  VENDOR_STATUS_TONE,
  dateOnly,
  humanise,
  number,
  percent,
  relativeTime,
} from "@/lib/format";
import type { Vendor, VendorFlag, VendorStatus } from "@/lib/types";

const PAGE_SIZE = 24;

type StatusFilter = VendorStatus | "all";

/**
 * `VendorFlagReason` in prose.
 *
 * The raw enum values ("low_on_time_rate") are machine keys; `humanise` would
 * render "Low on time rate", which reads like a typo. Anything the monitoring
 * job adds later still falls back to `humanise` rather than to nothing.
 */
const FLAG_REASON_LABEL: Record<string, string> = {
  late_deliveries: "Late deliveries",
  low_on_time_rate: "Low on-time rate",
  cancellations: "Cancellations",
  quantity_shortfall: "Quantity shortfall",
};

/** "1 day" / "7 days" — `number()` still does the grouping. */
function plural(value: number, singular: string, many = `${singular}s`): string {
  return `${number(value)} ${value === 1 ? singular : many}`;
}

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All vendors" },
  { value: "verified", label: VENDOR_STATUS_LABEL.verified },
  { value: "pending", label: VENDOR_STATUS_LABEL.pending },
  { value: "flagged", label: VENDOR_STATUS_LABEL.flagged },
  { value: "suspended", label: VENDOR_STATUS_LABEL.suspended },
];

/**
 * Keystrokes are cheap; round trips are not. 300ms sits below the threshold at
 * which a search field starts to feel like it is lagging behind the typist.
 */
function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/* ==========================================================================
   Page
   ========================================================================== */
export default function VendorsPage() {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [offset, setOffset] = useState(0);
  const [addOpen, setAddOpen] = useState(false);

  const search = useDebounced(searchInput.trim());

  // Any change of filter invalidates the current page window.
  useEffect(() => {
    setOffset(0);
  }, [status, search]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["vendors", { status, search, offset }],
    queryFn: () =>
      api.listVendors({
        status: status === "all" ? undefined : status,
        search: search || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: keepPreviousData,
  });

  const vendors = data?.items ?? [];
  const total = data?.total ?? 0;
  const filtered = status !== "all" || search.length > 0;
  const forbidden = error instanceof ApiError && error.isForbidden;

  // Guarded on the page being non-empty, not on the total: paging past the end
  // of a directory that shrank underneath you would otherwise read "25–24 of 24".
  const rangeLabel =
    vendors.length > 0
      ? `${number(offset + 1)}–${number(offset + vendors.length)} of ${number(total)}`
      : null;

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Every supplier the agent may price against. Verified and flagged vendors are quoted from; pending and suspended ones are not."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>
            Add vendor
          </Button>
        }
      />

      {/* ------------------------------------------------------------------
          Filters
          ------------------------------------------------------------------ */}
      <div className="glass-soft mb-5 rounded-[24px] p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-[320px]">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#a9bac3]" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search by vendor name"
              aria-label="Search vendors by name"
              className="pl-10 pr-9"
            />
            {searchInput.length > 0 && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                aria-label="Clear search"
                className="absolute right-3 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-[8px] text-[#a9bac3] transition-colors duration-200 hover:bg-white hover:text-[#5f7280]"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <ChipGroup options={STATUS_OPTIONS} value={status} onChange={setStatus} />
        </div>

        {rangeLabel && (
          <p className="mt-3 border-t border-white/60 pt-3 text-[11.5px] text-[#7e8c94]">
            Showing <span className="tnum font-semibold text-[#5f7280]">{rangeLabel}</span>
            {isFetching && !isLoading && (
              <span className="ml-2 text-[#a3b6c0]">updating…</span>
            )}
          </p>
        )}
      </div>

      {/* ------------------------------------------------------------------
          Loading · error · empty · data
          ------------------------------------------------------------------ */}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Card key={index} padded={false} className="p-5">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="mt-3 h-3.5 w-1/2" />
              <LoadingBlock rows={2} className="mt-5" />
            </Card>
          ))}
        </div>
      ) : forbidden ? (
        <Alert tone="warning" title="Not available for this account">
          The vendor directory is a buyer-side view. Sign in as an employee or an
          administrator to see it.
        </Alert>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : vendors.length === 0 ? (
        <EmptyState
          icon={<Users className="size-6" />}
          title={
            offset > 0
              ? "Nothing on this page"
              : filtered
                ? "No vendors match those filters"
                : "No vendors yet"
          }
          description={
            offset > 0
              ? "The directory is shorter than it was when you started paging through it. Go back to the first page to see what is there now."
              : filtered
                ? "Search matches the vendor name only — not the category or the contact details. Try a shorter term, or set the status filter back to all vendors."
                : "Add the suppliers you already buy from. Until at least one is verified, the agent has nowhere to fetch quotes from."
          }
          action={
            offset > 0 ? (
              <Button variant="secondary" onClick={() => setOffset(0)}>
                Back to the first page
              </Button>
            ) : filtered ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setStatus("all");
                  setSearchInput("");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button icon={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>
                Add vendor
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {vendors.map((vendor) => (
              <VendorCard key={vendor.id} vendor={vendor} />
            ))}
          </div>

          {total > PAGE_SIZE && (
            <div className="mt-6 flex items-center justify-between gap-3">
              <Button
                variant="secondary"
                size="sm"
                icon={<ChevronLeft className="size-4" />}
                disabled={offset === 0}
                onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
              >
                Previous
              </Button>
              <span className="tnum text-[12px] text-[#7e8c94]">{rangeLabel}</span>
              <Button
                variant="secondary"
                size="sm"
                iconRight={<ChevronRight className="size-4" />}
                disabled={offset + vendors.length >= total}
                onClick={() => setOffset((current) => current + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      <AddVendorModal open={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}

/* ==========================================================================
   Vendor card
   ========================================================================== */
function VendorCard({ vendor }: { vendor: Vendor }) {
  const openFlags = vendor.flags.filter((flag) => !flag.resolved_at);

  return (
    <Card
      as="article"
      padded={false}
      className="animate-fade-up flex flex-col p-5 transition-shadow duration-200 hover:shadow-[0_24px_50px_rgba(46,96,120,0.20)]"
    >
      {/* Identity */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The name is the way into the full record: reliability history,
              open flags and what this vendor actually lists. */}
          <h2 className="truncate text-[15.5px] font-semibold tracking-[-0.015em] text-[#243640]">
            <Link
              href={`/vendors/${vendor.id}`}
              className="transition-colors hover:text-[#447f98]"
            >
              {vendor.name}
            </Link>
          </h2>
          {vendor.legal_name && vendor.legal_name !== vendor.name && (
            <p className="mt-0.5 truncate text-[12px] text-[#7e8c94]">{vendor.legal_name}</p>
          )}
        </div>
        <StatusPill
          label={VENDOR_STATUS_LABEL[vendor.status]}
          tone={VENDOR_STATUS_TONE[vendor.status]}
          className="shrink-0"
        />
      </div>

      {vendor.category && (
        <div className="mt-3">
          <Badge tone="brand">{vendor.category}</Badge>
        </div>
      )}

      {/* Contact */}
      <div className="mt-4 space-y-2">
        <ContactRow icon={<Mail className="size-3.5" />} value={vendor.email} />
        <ContactRow icon={<Phone className="size-3.5" />} value={vendor.phone} mono />
        <ContactRow icon={<MapPin className="size-3.5" />} value={vendor.address} />
      </div>

      {/* Reliability — printed exactly as the API computed it */}
      <ReliabilityBlock vendor={vendor} />

      {/* Unresolved flags */}
      {openFlags.length > 0 && (
        <div className="mt-3 space-y-2">
          {openFlags.map((flag, index) => (
            <FlagChip key={`${flag.reason}-${flag.raised_at}-${index}`} flag={flag} />
          ))}
        </div>
      )}

      {/* Terms and catalog — pinned to the bottom so cards align in a row */}
      <div className="mt-auto pt-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[#e7eff3] pt-4">
          <MetaCell
            icon={<Truck className="size-3.5" />}
            label="Default delivery"
            value={
              vendor.default_delivery_days === null
                ? "Not specified"
                : plural(vendor.default_delivery_days, "day")
            }
            dim={vendor.default_delivery_days === null}
          />
          <MetaCell
            icon={<ShieldCheck className="size-3.5" />}
            label="Default warranty"
            value={
              vendor.default_warranty_months === null
                ? "Not specified"
                : plural(vendor.default_warranty_months, "month")
            }
            dim={vendor.default_warranty_months === null}
          />
          <MetaCell
            icon={<BadgeCheck className="size-3.5" />}
            label="Verified"
            value={vendor.verified_at ? dateOnly(vendor.verified_at) : "Not yet"}
            dim={!vendor.verified_at}
          />
          <MetaCell
            icon={<CalendarClock className="size-3.5" />}
            label="Last published"
            value={
              vendor.last_published_at ? relativeTime(vendor.last_published_at) : "Never"
            }
            dim={!vendor.last_published_at}
          />
        </div>
      </div>
    </Card>
  );
}

function ContactRow({
  icon,
  value,
  mono,
}: {
  icon: ReactNode;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className={cn("mt-0.5 shrink-0", value ? "text-[#93a7b1]" : "text-[#cbd9e0]")}>
        {icon}
      </span>
      <span
        className={cn(
          "min-w-0 break-words text-[12.5px] leading-relaxed",
          value ? "text-[#4a5c66]" : "text-[#b3c4cc]",
          mono && value && "tnum font-mono text-[12px]",
        )}
      >
        {value ?? "Not provided"}
      </span>
    </div>
  );
}

function MetaCell({
  icon,
  label,
  value,
  dim,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  dim?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#a3b6c0]">
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </p>
      <p
        className={cn(
          "tnum mt-1 truncate text-[13px] font-semibold",
          dim ? "text-[#b3c4cc]" : "text-[#243640]",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * `display` is rendered exactly as the API produced it. When a vendor has too
 * few fulfilled orders the backend refuses to compute a rating at all, and this
 * block says so rather than showing a zero or an optimistic default.
 */
function ReliabilityBlock({ vendor }: { vendor: Vendor }) {
  const reliability = vendor.reliability;

  return (
    <div className="glass-flat mt-4 rounded-[20px] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#a3b6c0]">
          Reliability
        </p>
        {reliability.has_history && (
          <p className="tnum text-[11.5px] text-[#7e8c94]">
            {plural(reliability.orders_fulfilled, "order")} fulfilled
          </p>
        )}
      </div>

      <p
        className={cn(
          "tnum mt-1.5 font-bold tracking-[-0.02em]",
          reliability.has_history
            ? "text-[22px] leading-none text-[#243640]"
            : "text-[14px] leading-snug text-[#7e8c94]",
        )}
      >
        {reliability.display}
      </p>

      {reliability.has_history ? (
        <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
          <ReliabilityStat label="On time" value={percent(reliability.on_time_rate)} />
          <ReliabilityStat
            label="Quantity accuracy"
            value={percent(reliability.quantity_accuracy)}
          />
          <ReliabilityStat
            label="Late deliveries"
            value={number(reliability.late_deliveries)}
            alarm={reliability.late_deliveries > 0}
          />
          <ReliabilityStat
            label="Cancellations"
            value={number(reliability.cancellations)}
            alarm={reliability.cancellations > 0}
          />
        </dl>
      ) : (
        <p className="mt-2 text-[11.5px] leading-relaxed text-[#7e8c94]">
          This vendor has fewer fulfilled orders than the configured minimum, so the
          scorer uses a neutral sub-score and surfaces the caveat rather than guessing
          a rating.
        </p>
      )}
    </div>
  );
}

function ReliabilityStat({
  label,
  value,
  alarm,
}: {
  label: string;
  value: string;
  alarm?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] text-[#7e8c94]">{label}</dt>
      <dd
        className={cn(
          "tnum text-[13px] font-semibold",
          alarm ? "text-[#b54708]" : "text-[#243640]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function FlagChip({ flag }: { flag: VendorFlag }) {
  return (
    <div className="rounded-[16px] border border-[#fecdca] bg-[#fef3f2] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-[#b42318]">
          <AlertTriangle className="size-3" />
          {FLAG_REASON_LABEL[flag.reason] ?? humanise(flag.reason)}
        </span>
        <span className="text-[11px] text-[#c07068]">{relativeTime(flag.raised_at)}</span>
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-[#b42318]">{flag.detail}</p>
      <p className="mt-1 text-[11px] text-[#c07068]">Threshold · {flag.threshold}</p>
    </div>
  );
}

/* ==========================================================================
   Add vendor
   ========================================================================== */
interface VendorForm {
  name: string;
  legal_name: string;
  email: string;
  phone: string;
  address: string;
  category: string;
  default_delivery_days: string;
  default_warranty_months: string;
}

const EMPTY_FORM: VendorForm = {
  name: "",
  legal_name: "",
  email: "",
  phone: "",
  address: "",
  category: "",
  default_delivery_days: "",
  default_warranty_months: "",
};

/** "" → null. The API reads null as "not specified", which is not the same as "". */
function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalCount(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function AddVendorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<VendorForm>(EMPTY_FORM);
  const [touched, setTouched] = useState(false);

  const nameError =
    touched && form.name.trim().length < 2 ? "Enter at least two characters." : undefined;

  const mutation = useMutation({
    mutationFn: () =>
      api.createVendor({
        name: form.name.trim(),
        legal_name: optionalText(form.legal_name),
        email: optionalText(form.email),
        phone: optionalText(form.phone),
        address: optionalText(form.address),
        category: optionalText(form.category),
        default_delivery_days: optionalCount(form.default_delivery_days),
        default_warranty_months: optionalCount(form.default_warranty_months),
      }),
    onSuccess: (vendor: Vendor) => {
      void queryClient.invalidateQueries({ queryKey: ["vendors"] });
      toast(`${vendor.name} added — pending an administrator's verification.`);
      setForm(EMPTY_FORM);
      setTouched(false);
      onClose();
    },
    onError: (mutationError: unknown) => {
      toast(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not add the vendor.",
        "danger",
      );
    },
  });

  const update = (key: keyof VendorForm, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (form.name.trim().length < 2) return;
    mutation.mutate();
  };

  // Abandoning the form discards it. Reopening a modal that still holds a
  // half-typed vendor — and a validation error from the attempt before —
  // reads as a bug rather than as a convenience.
  const close = () => {
    if (mutation.isPending) return;
    setForm(EMPTY_FORM);
    setTouched(false);
    mutation.reset();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      width={620}
      title="Add a vendor"
      description="Only the display name is required. Everything else can be filled in later, or by the vendor once they have a portal account."
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-vendor-form"
            loading={mutation.isPending}
            icon={<Plus className="size-4" />}
          >
            Add vendor
          </Button>
        </>
      }
    >
      <form id="add-vendor-form" onSubmit={onSubmit} className="space-y-4 pb-2">
        <Alert tone="warning" title="This vendor will land as “Pending review”">
          The agent fetches quotes from verified and flagged vendors only. An
          administrator must verify this vendor before it can appear in a comparison
          or on a purchase order.
        </Alert>

        <Field
          label="Vendor name"
          htmlFor="vendor-name"
          required
          error={nameError}
          hint="The trading name people on your team would recognise."
        >
          <Input
            id="vendor-name"
            value={form.name}
            invalid={Boolean(nameError)}
            onChange={(event) => update("name", event.target.value)}
            placeholder="Karachi Office Supplies"
            autoComplete="off"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Registered legal name" htmlFor="vendor-legal">
            <Input
              id="vendor-legal"
              value={form.legal_name}
              onChange={(event) => update("legal_name", event.target.value)}
              placeholder="Karachi Office Supplies (Pvt) Ltd"
              autoComplete="off"
            />
          </Field>
          <Field label="Category" htmlFor="vendor-category">
            <Input
              id="vendor-category"
              value={form.category}
              onChange={(event) => update("category", event.target.value)}
              placeholder="IT hardware"
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" htmlFor="vendor-email">
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#a9bac3]" />
              <Input
                id="vendor-email"
                type="email"
                value={form.email}
                onChange={(event) => update("email", event.target.value)}
                placeholder="sales@vendor.com"
                autoComplete="off"
                className="pl-10"
              />
            </div>
          </Field>
          <Field label="Phone" htmlFor="vendor-phone">
            <div className="relative">
              <Phone className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#a9bac3]" />
              <Input
                id="vendor-phone"
                type="tel"
                value={form.phone}
                onChange={(event) => update("phone", event.target.value)}
                placeholder="+92 21 3456 7890"
                autoComplete="off"
                className="pl-10"
              />
            </div>
          </Field>
        </div>

        <Field label="Address" htmlFor="vendor-address">
          <div className="relative">
            <MapPin className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#a9bac3]" />
            <Input
              id="vendor-address"
              value={form.address}
              onChange={(event) => update("address", event.target.value)}
              placeholder="Plot 14, Korangi Industrial Area, Karachi"
              autoComplete="off"
              className="pl-10"
            />
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Default delivery (days)"
            htmlFor="vendor-delivery"
            hint="Inherited by catalog items that do not state their own."
          >
            <Input
              id="vendor-delivery"
              type="number"
              min={0}
              inputMode="numeric"
              value={form.default_delivery_days}
              onChange={(event) => update("default_delivery_days", event.target.value)}
              placeholder="7"
              className="tnum"
            />
          </Field>
          <Field
            label="Default warranty (months)"
            htmlFor="vendor-warranty"
            hint="Leave blank if the vendor has not committed to one."
          >
            <Input
              id="vendor-warranty"
              type="number"
              min={0}
              inputMode="numeric"
              value={form.default_warranty_months}
              onChange={(event) => update("default_warranty_months", event.target.value)}
              placeholder="12"
              className="tnum"
            />
          </Field>
        </div>

        <p className="flex items-start gap-2 pb-1 text-[11.5px] leading-relaxed text-[#7e8c94]">
          <Building2 className="mt-0.5 size-3.5 shrink-0 text-[#a3b6c0]" />
          Missing delivery or warranty terms are not fatal — they lower the data
          confidence of any quote built from this vendor, and the comparison says so.
        </p>
      </form>
    </Modal>
  );
}
