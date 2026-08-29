"use client";

/**
 * Screen 15a — the buyer-side catalog browser.
 *
 * This page is deliberately close to the query the agent runs. `GET /catalog/browse`
 * returns only items that are visible, that have actually been published, and
 * whose vendor is verified or flagged — the same rows `fetch_quotes` matches
 * against. So if something is not here, no quote will ever contain it, and this
 * is the fastest way to find out why.
 *
 * The one place browse is looser than the agent: `find_offers` also requires
 * `stock >= quantity`, which browse does not apply because it has no quantity
 * to compare against. An out-of-stock item therefore appears here and still
 * never reaches a comparison, so the card says so in as many words.
 *
 * One wrinkle: browse returns a bare list with no `total`. There is nothing to
 * count against, so pagination is inferred — a response that fills the page
 * size means there is probably another page, and a short one means we have
 * reached the end. That is why "Next" is enabled by page fullness rather than
 * by a remaining count, and why no "x of y" figure is shown.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Boxes,
  PackageSearch,
  Search,
  ShieldCheck,
  Store,
  Truck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  cn,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { humanise, money, number } from "@/lib/format";
import type { CatalogItem } from "@/lib/types";

const PAGE_SIZE = 24;

/** The two fields the catalog serializer can report as unstated. */
const MISSING_TERM_LABEL: Record<string, string> = {
  delivery_days: "a delivery time",
  warranty_months: "a warranty period",
};

/** "1 day" / "7 days" — `number()` still does the grouping. */
function plural(value: number, singular: string, many = `${singular}s`): string {
  return `${number(value)} ${value === 1 ? singular : many}`;
}

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
export default function CatalogPage() {
  const [searchInput, setSearchInput] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [offset, setOffset] = useState(0);

  const search = useDebounced(searchInput.trim());

  useEffect(() => {
    setOffset(0);
  }, [search, vendorId]);

  const itemsQuery = useQuery({
    queryKey: ["catalog", "browse", { search, vendorId, offset }],
    queryFn: () =>
      api.browseCatalog({
        search: search || undefined,
        vendor_id: vendorId || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: keepPreviousData,
  });

  // The vendor filter. Only verified and flagged vendors can have browsable
  // items, so offering the others would produce guaranteed-empty results.
  const vendorsQuery = useQuery({
    queryKey: ["vendors", "filter-options"],
    queryFn: () => api.listVendors({ limit: 100 }),
    staleTime: 60_000,
  });

  const vendorOptions = useMemo(() => {
    const rows = vendorsQuery.data?.items ?? [];
    return rows
      .filter((vendor) => vendor.status === "verified" || vendor.status === "flagged")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [vendorsQuery.data]);

  const items = itemsQuery.data ?? [];
  const filtered = search.length > 0 || vendorId.length > 0;
  const forbidden = itemsQuery.error instanceof ApiError && itemsQuery.error.isForbidden;

  // No total is returned, so "there is more" is inferred from page fullness.
  const hasNextPage = items.length === PAGE_SIZE;
  const showPager = offset > 0 || hasNextPage;

  const selectedVendorName = vendorOptions.find((vendor) => vendor.id === vendorId)?.name;

  return (
    <>
      <PageHeader
        title="Catalog"
        description="Published vendor stock, priced and in the units the agent will quote from."
      />

      {/* ------------------------------------------------------------------
          Filters
          ------------------------------------------------------------------ */}
      <div className="glass-soft mb-5 rounded-[24px] p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_260px]">
          <Field label="Search" htmlFor="catalog-search">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#a9bac3]" />
              <Input
                id="catalog-search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Title, brand or description"
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
          </Field>

          <Field
            label="Vendor"
            htmlFor="catalog-vendor"
            error={
              vendorsQuery.isError
                ? "The vendor list could not be loaded, so this filter has nothing to offer. Browsing every vendor still works."
                : undefined
            }
          >
            <Select
              id="catalog-vendor"
              value={vendorId}
              disabled={vendorsQuery.isLoading}
              onChange={(event) => setVendorId(event.target.value)}
            >
              <option value="">
                {vendorsQuery.isLoading ? "Loading vendors…" : "All vendors"}
              </option>
              {/*
                A vendor can drop out of the options between renders — it is
                suspended, or it falls past the first page of the directory —
                while the filter is still applied. Without this the control
                renders blank and the active filter becomes invisible.
              */}
              {vendorId.length > 0 &&
                !vendorOptions.some((vendor) => vendor.id === vendorId) && (
                  <option value={vendorId}>
                    {selectedVendorName ?? "Selected vendor"}
                  </option>
                )}
              {vendorOptions.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <p className="mt-3 flex items-start gap-2 border-t border-white/60 pt-3 text-[11.5px] leading-relaxed text-[#7e8c94]">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[#a3b6c0]" />
          Only published, visible items from verified or flagged vendors appear here —
          the same rows the agent reads when it fetches quotes. Draft edits and items
          from pending or suspended vendors are invisible to both of you. The agent
          adds one more filter of its own: it will not quote an item whose stock
          cannot cover the requested quantity.
        </p>

        {(filtered || itemsQuery.isFetching) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {search.length > 0 && (
              <FilterChip label={`“${search}”`} onClear={() => setSearchInput("")} />
            )}
            {vendorId.length > 0 && (
              <FilterChip
                label={selectedVendorName ?? "Selected vendor"}
                onClear={() => setVendorId("")}
              />
            )}
            {itemsQuery.isFetching && !itemsQuery.isLoading && (
              <span className="text-[11.5px] text-[#a3b6c0]">updating…</span>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------
          Loading · error · empty · data
          ------------------------------------------------------------------ */}
      {itemsQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Card key={index} padded={false} className="p-5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-5 w-3/4" />
              <Skeleton className="mt-2 h-3.5 w-full" />
              <Skeleton className="mt-6 h-7 w-1/2" />
              <Skeleton className="mt-5 h-12 w-full" />
            </Card>
          ))}
        </div>
      ) : forbidden ? (
        <Alert tone="warning" title="Not available for this account">
          Catalog browse is a buyer-side view. A vendor account manages its own items
          from the vendor portal instead.
        </Alert>
      ) : itemsQuery.error ? (
        <ErrorState error={itemsQuery.error} onRetry={() => void itemsQuery.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<PackageSearch className="size-6" />}
          title={
            offset > 0
              ? "Nothing on this page"
              : filtered
                ? "Nothing matches those filters"
                : "No published items yet"
          }
          description={
            offset > 0
              ? "There are fewer items than there were when you started paging through them. Go back to the first page to see what is published now."
              : filtered
                ? "Search matches title, brand and description only — try a shorter term, or widen the vendor filter."
                : "Vendors have not published any items to this organisation yet. An item exists but stays hidden until its vendor publishes it and an administrator has verified that vendor."
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
                  setSearchInput("");
                  setVendorId("");
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <CatalogCard key={item.id} item={item} />
            ))}
          </div>

          {showPager && (
            <div className="mt-6 flex items-center justify-between gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
              >
                Previous
              </Button>
              <span className="tnum text-[12px] text-[#7e8c94]">
                {number(offset + 1)}–{number(offset + items.length)}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={!hasNextPage}
                onClick={() => setOffset((current) => current + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#b9d8e1] bg-[#d6ebf3] px-2.5 py-1 text-[11.5px] font-semibold text-[#38677b]">
      <span className="max-w-[220px] truncate">{label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove filter ${label}`}
        className="grid size-4 place-items-center rounded-full transition-colors duration-200 hover:bg-white/70"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/* ==========================================================================
   Item card
   ========================================================================== */
function CatalogCard({ item }: { item: CatalogItem }) {
  const onSale = item.sale_price !== null;

  return (
    <Card
      as="article"
      padded={false}
      className="animate-fade-up flex flex-col p-5 transition-shadow duration-200 hover:shadow-[0_24px_50px_rgba(46,96,120,0.20)]"
    >
      {/* Provenance */}
      <div className="flex items-start justify-between gap-3">
        <p className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-semibold text-[#447f98]">
          <Store className="size-3.5 shrink-0" />
          <span className="truncate">{item.vendor_name ?? "Unnamed vendor"}</span>
        </p>
        {onSale && <Badge tone="positive">Sale</Badge>}
      </div>

      {/* Identity */}
      <h2 className="mt-2 line-clamp-2 text-[15px] font-semibold leading-snug tracking-[-0.015em] text-[#243640]">
        {item.title}
      </h2>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Mono>{item.sku}</Mono>
        {item.brand && <span className="text-[12px] text-[#5f7280]">{item.brand}</span>}
        {item.category && <Badge tone="neutral">{item.category}</Badge>}
      </div>

      {item.description && (
        <p className="mt-3 line-clamp-2 text-[12.5px] leading-relaxed text-[#7e8c94]">
          {item.description}
        </p>
      )}

      {/* Price — the effective figure leads, because that is what gets quoted */}
      <div className="mt-4 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="tnum text-[22px] font-bold leading-none tracking-[-0.03em] text-[#243640]">
          {money(item.effective_price, item.currency)}
        </span>
        {onSale && (
          <span className="tnum text-[13px] text-[#a3b6c0] line-through">
            {money(item.price, item.currency)}
          </span>
        )}
      </div>

      {/* Terms */}
      <div className="mt-auto pt-4">
        <div className="grid grid-cols-3 gap-x-3 gap-y-3 border-t border-[#e7eff3] pt-4">
          <TermCell
            icon={<Boxes className="size-3.5" />}
            label="Stock"
            value={number(item.stock)}
            dim={item.stock === 0}
          />
          <TermCell
            icon={<Truck className="size-3.5" />}
            label="Delivery"
            value={
              item.delivery_days === null
                ? "Not stated"
                : plural(item.delivery_days, "day")
            }
            dim={item.delivery_days === null}
          />
          <TermCell
            icon={<ShieldCheck className="size-3.5" />}
            label="Warranty"
            value={
              item.warranty_months === null
                ? "Not stated"
                : `${number(item.warranty_months)} mo`
            }
            dim={item.warranty_months === null}
          />
        </div>

        {/*
          `is_low_stock` is true at zero too, and "Low stock" badly understates
          that case: `find_offers` requires stock >= the requested quantity, so
          an item at zero is unquotable rather than merely tight.
        */}
        {(item.stock === 0 || item.is_low_stock) && (
          <div className="mt-3">
            <StatusPill
              label={item.stock === 0 ? "Out of stock" : "Low stock"}
              tone={item.stock === 0 ? "danger" : "warning"}
              size="sm"
            />
          </div>
        )}

        {item.stock === 0 && (
          <p className="mt-2 text-[11.5px] leading-relaxed text-[#b42318]">
            The agent only quotes an item whose stock covers the requested quantity,
            so this one cannot appear in a comparison until the vendor restocks it.
          </p>
        )}

        {item.missing_terms.length > 0 && <MissingTerms fields={item.missing_terms} />}
      </div>
    </Card>
  );
}

function TermCell({
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
      <p className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#a3b6c0]">
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
 * An unstated term is not an error — it is a gap the scorer has to impute
 * around, and the comparison reports the resulting confidence. Saying so here
 * is cheaper than explaining it after the quote comes back looking odd.
 */
function MissingTerms({ fields }: { fields: string[] }) {
  const names = fields.map((field) => MISSING_TERM_LABEL[field] ?? humanise(field));
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  return (
    <p className="mt-3 text-[11.5px] leading-relaxed text-[#b54708]">
      The vendor has not specified {list} for this item, which lowers the data
      confidence of any quote built from it.
    </p>
  );
}
