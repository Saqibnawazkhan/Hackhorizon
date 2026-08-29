"use client";

/**
 * Workflow history — screen 10a.
 *
 * Every request this console has planned or executed, filterable by status,
 * by type and by free text. The filters are the query key, so the URL of the
 * data — not a client-side array — is what changes when you narrow the list;
 * a 400-row history never reaches the browser.
 *
 * The search box is debounced by 300ms because the endpoint runs an ILIKE
 * over titles: typing "laptop" should cost one request, not six.
 *
 * A vendor is refused here by design (`BuyerDep` on the router, 403 rather
 * than an empty list — the backend deliberately refuses instead of quietly
 * returning nothing). That is a correct answer to a wrong question, so it is
 * rendered as an explanation rather than as a failure.
 */
import {
  ChevronLeft,
  ChevronRight,
  History,
  Search,
  Send,
  ShieldAlert,
  SlidersHorizontal,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Button,
  Card,
  ChipGroup,
  EmptyState,
  ErrorState,
  Input,
  LoadingBlock,
  Spinner,
  StatusPill,
  Table,
  Td,
  Th,
  Tr,
  cn,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  WORKFLOW_STATUS_LABEL,
  WORKFLOW_STATUS_TONE,
  dateTime,
  duration,
  humanise,
  money,
  relativeTime,
} from "@/lib/format";
import type { WorkflowStatus, WorkflowType } from "@/lib/types";

const PAGE_SIZE = 20;

type StatusFilter = WorkflowStatus | "all";
type TypeFilter = WorkflowType | "all";

/**
 * Ordered by how often an operator actually reaches for them, not by the
 * enum's declaration order. Labels always come from the shared map.
 */
const STATUS_ORDER: WorkflowStatus[] = [
  "running",
  "awaiting_approval",
  "completed",
  "escalated",
  "approved",
  "rejected",
  "failed",
  "draft",
];

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  ...STATUS_ORDER.map((status) => ({
    value: status as StatusFilter,
    label: WORKFLOW_STATUS_LABEL[status],
  })),
];

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "procurement", label: humanise("procurement") },
  { value: "reimbursement", label: humanise("reimbursement") },
];

export default function WorkflowsPage() {
  const router = useRouter();

  const [status, setStatus] = useState<StatusFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  // Debounce the text box into the value the query key actually uses.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Any change of filter invalidates the page you were on: page 3 of a
  // narrower result set is usually empty, which reads as "no results".
  useEffect(() => {
    setOffset(0);
  }, [status, type, search]);

  const { data, isLoading, isFetching, isPlaceholderData, error, refetch } = useQuery({
    queryKey: ["workflows", { status, type, search, offset }],
    queryFn: () =>
      api.listWorkflows({
        status: status === "all" ? undefined : status,
        workflow_type: type === "all" ? undefined : type,
        search: search || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    // Paging and filtering keep the previous page on screen while the next
    // one loads: replacing a table with a skeleton on every keystroke reads
    // as a reload, and it is what makes the `isFetching` spinner meaningful.
    placeholderData: keepPreviousData,
  });

  const filtered = status !== "all" || type !== "all" || search !== "";
  const items = Array.isArray(data?.items) ? data.items : [];
  const total = data?.total ?? 0;
  /**
   * A failed fetch is only fatal when what is on screen no longer answers the
   * question being asked.
   *
   * `isPlaceholderData` is exactly that distinction: true means these rows
   * belong to the *previous* filter and the newly-requested one failed, so
   * leaving them up under the new chips would be a lie — show the error. False
   * means the refetch of the filter you are already looking at failed, and the
   * honest move is to keep the rows and say they may be a moment old.
   */
  const fatalError = error && (!data || isPlaceholderData);
  const staleError = error && !fatalError;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + items.length, total);
  // Rows can disappear under you — a run finishes, an admin's view narrows —
  // and an offset past the end then answers "no workflows yet", which is a
  // lie. Say what actually happened and offer the way back.
  const pastEnd = items.length === 0 && offset > 0;

  const clearFilters = () => {
    setStatus("all");
    setType("all");
    setSearchInput("");
    setSearch("");
  };

  /* ----------------------------------------------------------------------
     A vendor account reaching this route is not a bug and not an outage.
     ---------------------------------------------------------------------- */
  if (error instanceof ApiError && error.isForbidden) {
    return (
      <>
        <PageHeader
          title="Workflows"
          description="Buyer workflow history."
        />
        <EmptyState
          icon={<ShieldAlert className="size-6" />}
          title="Workflow history is not part of the vendor portal"
          description="Buyer requests, quotes and approvals belong to the organisation that raised them, so vendor accounts are refused this list at the API. Your own orders and catalog live in the portal."
          action={
            <Button variant="secondary" onClick={() => router.push("/portal")}>
              Go to my portal
            </Button>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Every request the agent has planned or executed. Open one to watch it run, or to read back exactly what it did and why."
        actions={
          <Button
            variant="secondary"
            icon={<Send className="size-3.5" />}
            onClick={() => router.push("/requests/new")}
          >
            New request
          </Button>
        }
      />

      {/* ------------------------------------------------------------------
          Filter bar
          ------------------------------------------------------------------ */}
      <Card variant="soft" padded={false} className="mb-5 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-[380px]">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#a9bac3]" />
            <Input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search request titles…"
              aria-label="Search workflows"
              className="pl-10 pr-9"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                aria-label="Clear search"
                className="absolute right-3 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-[8px] text-[#a9bac3] transition-colors hover:bg-white hover:text-[#5f7280]"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <ChipGroup
            options={TYPE_OPTIONS}
            value={type}
            onChange={setType}
            className="lg:justify-end"
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-white/70 pt-4">
          <SlidersHorizontal className="size-3.5 shrink-0 text-[#a3b6c0]" />
          <ChipGroup options={STATUS_OPTIONS} value={status} onChange={setStatus} />
          {filtered && (
            <button
              type="button"
              onClick={clearFilters}
              className="ml-auto text-[12px] font-semibold text-[#447f98] transition-colors hover:text-[#38677b]"
            >
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {/* ------------------------------------------------------------------
          Results
          ------------------------------------------------------------------ */}
      {/* A refetch of the view you are already on failed. The rows below are
          still the answer to the question on screen, so this explains rather
          than replaces them. */}
      {staleError && (
        <Alert
          tone="warning"
          title="Could not refresh this list"
          className="mb-5"
          action={
            <Button size="sm" variant="secondary" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        >
          {error instanceof Error
            ? error.message
            : "The last request did not reach the API."}{" "}
          The history below is the last version that loaded.
        </Alert>
      )}

      {isLoading ? (
        <Card>
          <LoadingBlock rows={6} />
        </Card>
      ) : fatalError ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<History className="size-6" />}
          title={
            pastEnd
              ? "Nothing on this page"
              : filtered
                ? "Nothing matches this filter"
                : "No workflows yet"
          }
          description={
            pastEnd
              ? "This page is past the end of the current result set — the history is shorter than it was when you paged here."
              : filtered
                ? "No request in your history matches the current status, type and search combination. Widen the filter to see more."
                : "Describe a purchase or a claim in plain English and the agent will plan it, show you the plan, and wait for your confirmation before anything runs."
          }
          action={
            pastEnd ? (
              <Button variant="secondary" onClick={() => setOffset(0)}>
                Back to the first page
              </Button>
            ) : filtered ? (
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : (
              <Button
                icon={<Send className="size-3.5" />}
                onClick={() => router.push("/requests/new")}
              >
                Start a request
              </Button>
            )
          }
        />
      ) : (
        <Card>
          <div className="flex items-center justify-between gap-3 pb-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
              Showing <span className="tnum text-[#243640]">{from}–{to}</span> of{" "}
              <span className="tnum text-[#243640]">{total}</span>
            </p>
            {isFetching && <Spinner className="size-3.5" />}
          </div>

          <Table minWidth={880}>
            <thead>
              <tr>
                <Th>Request</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th align="right">Amount</Th>
                <Th>Created</Th>
                <Th align="right">Duration</Th>
                <Th className="w-8">
                  <span className="sr-only">Open</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {items.map((workflow) => (
                <Tr
                  key={workflow.id}
                  onClick={() => router.push(`/workflows/${workflow.id}`)}
                  className="group"
                >
                  <Td className="pr-4">
                    {/* max-width belongs on the child: an auto-layout table
                        ignores it on the cell, so the column would grow to
                        fit the longest title and `truncate` would never fire. */}
                    <Link
                      href={`/workflows/${workflow.id}`}
                      onClick={(event) => event.stopPropagation()}
                      className="block max-w-[320px] truncate font-semibold text-[#243640] transition-colors group-hover:text-[#38677b]"
                      title={workflow.title}
                    >
                      {workflow.title}
                    </Link>
                  </Td>
                  <Td className="text-[12.5px] text-[#5f7280]">
                    {humanise(workflow.workflow_type)}
                  </Td>
                  <Td>
                    <StatusPill
                      size="sm"
                      label={WORKFLOW_STATUS_LABEL[workflow.status]}
                      tone={WORKFLOW_STATUS_TONE[workflow.status]}
                    />
                  </Td>
                  <Td align="right" className="font-semibold">
                    {money(workflow.total_amount, workflow.currency)}
                  </Td>
                  <Td className="text-[12.5px] text-[#5f7280]">
                    <span title={dateTime(workflow.created_at)}>
                      {relativeTime(workflow.created_at)}
                    </span>
                  </Td>
                  <Td align="right" className="text-[12.5px] text-[#5f7280]">
                    {duration(workflow.duration_ms)}
                  </Td>
                  <Td align="right">
                    <ChevronRight
                      className={cn(
                        "size-4 text-[#c3d4dc] transition-all duration-200",
                        "group-hover:translate-x-0.5 group-hover:text-[#447f98]",
                      )}
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>

          {/* Pagination — offset/limit, exactly as the endpoint pages */}
          <div className="-mx-6 mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#eef4f7] px-6 pt-4">
            <p className="text-[12px] text-[#7e8c94]">
              Page{" "}
              <span className="tnum font-semibold text-[#243640]">
                {Math.floor(offset / PAGE_SIZE) + 1}
              </span>{" "}
              of{" "}
              <span className="tnum font-semibold text-[#243640]">
                {Math.max(1, Math.ceil(total / PAGE_SIZE))}
              </span>
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon={<ChevronLeft className="size-3.5" />}
                disabled={offset === 0}
                onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                iconRight={<ChevronRight className="size-3.5" />}
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset((current) => current + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
