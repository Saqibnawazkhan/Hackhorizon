"use client";

/**
 * Spreadsheet import — vendor portal.
 *
 * The backend has always had the schema, the adapter and the endpoints. What
 * it never had was a client that let a vendor SEE what a file would do before
 * it did it. That is this screen, and it is three stages on purpose:
 *
 *   1. Upload  — the file is sized and sniffed here, before a byte is sent.
 *   2. Review  — POST /imports/preview parses, maps and validates every row
 *                and WRITES NOTHING. The verdicts are stored against an import
 *                job, so what the vendor approves is exactly what commits and
 *                the file is never re-read.
 *   3. Result  — POST /imports/{id}/commit upserts through CsvSource, the same
 *                CatalogSource adapter a hand-typed item or an API sync goes
 *                through, so an imported row obeys identical rules.
 *
 * Editing the mapping here is not cosmetic. The commit re-validates the stored
 * raw rows against the mapping this screen sends, which is how a mis-detected
 * column is corrected without re-uploading anything.
 *
 * Imported prices carry no currency of their own — the backend stamps the
 * vendor profile's currency at commit — so the preview renders them as plain
 * grouped numbers and says so, rather than asserting a currency the file never
 * contained.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  History,
  ListChecks,
  RotateCcw,
  Table2,
  UploadCloud,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Mono,
  Panel,
  Select,
  StatusPill,
  Switch,
  TONE_TEXT,
  Table,
  Td,
  Th,
  Tr,
  cn,
  useToast,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  asNumber,
  dateTime,
  humanise,
  number as formatNumber,
  relativeTime,
  type Tone,
} from "@/lib/format";
import type {
  ImportColumnMapping,
  ImportCommitResult,
  ImportJobStatus,
  ImportPreview,
  ImportRowVerdict,
  ImportTargetField,
} from "@/lib/types";

/* ==========================================================================
   Local vocabulary. None of these maps exist in format.ts, so they are
   defined once here rather than re-invented per component.
   ========================================================================== */
type Stage = "upload" | "review" | "result";

const IMPORT_STATUS_LABEL: Record<ImportJobStatus, string> = {
  uploaded: "Uploaded",
  previewed: "Previewed",
  committed: "Imported",
  partially_committed: "Partly imported",
  failed: "Failed",
  cancelled: "Cancelled",
};

const IMPORT_STATUS_TONE: Record<ImportJobStatus, Tone> = {
  uploaded: "muted",
  previewed: "brand",
  committed: "positive",
  partially_committed: "warning",
  failed: "danger",
  cancelled: "muted",
};

/**
 * The importer's target fields, in words.
 *
 * `humanise` alone would put "Sku" and "Delivery days" on screen, and the same
 * field would then be called two different things in the mapping, the table
 * header and the row verdict. One map, used everywhere a field is named.
 */
const FIELD_LABEL: Record<string, string> = {
  sku: "SKU",
  title: "Title",
  price: "Price",
  stock: "Stock",
  delivery_days: "Delivery time",
  warranty_months: "Warranty",
  description: "Description",
  category: "Category",
  brand: "Brand",
  sale_price: "Sale price",
};

/** Target fields the validator coerces to a number — these columns align right. */
const NUMERIC_TARGETS = new Set([
  "price",
  "sale_price",
  "stock",
  "delivery_days",
  "warranty_months",
]);

/** Of those, the ones that carry decimals and must not be rounded on screen. */
const MONEY_TARGETS = new Set(["price", "sale_price"]);

/** Rendering every row of a five-thousand-row file would jam the main thread. */
const TABLE_ROW_CAP = 200;

/* ==========================================================================
   Helpers
   ========================================================================== */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * The starter CSV comes down inside the JSON template, not from a link.
 *
 * A bare <a href="…/imports/template.csv"> cannot carry the bearer token, so
 * it would answer 401. Building the Blob from `template.csv` keeps the
 * download authenticated, and instant.
 */
function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * One parsed cell.
 *
 * Money arrives as an exact decimal STRING — JSONB cannot hold a Decimal, so
 * the validator stores `price` as "174000.50". Rendering that at zero decimals
 * would print 174,001 and quietly misstate what the file actually said, so a
 * fractional amount keeps its two places and a whole one stays clean.
 */
function cellValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value !== "number" && typeof value !== "string") {
    return NUMERIC_TARGETS.has(field) ? "—" : String(value);
  }
  if (MONEY_TARGETS.has(field)) {
    const amount = asNumber(value);
    if (amount === null) return String(value);
    return formatNumber(amount, Number.isInteger(amount) ? 0 : 2);
  }
  if (NUMERIC_TARGETS.has(field)) return formatNumber(value);
  return String(value);
}

function fieldLabel(name: string): string {
  return FIELD_LABEL[name] ?? humanise(name);
}

/* ==========================================================================
   Small local surfaces — clay, because this is the vendor portal
   ========================================================================== */
function ClayTile({
  label,
  value,
  tone = "neutral",
  sub,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  sub?: string;
}) {
  return (
    <Card variant="clay" padded={false} className="p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
        {label}
      </p>
      <p
        className={cn(
          "tnum mt-2.5 text-[26px] font-bold leading-none tracking-[-0.03em]",
          tone === "neutral" ? "text-[#2e3e47]" : TONE_TEXT[tone],
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-2 text-[11.5px] leading-snug text-[#7e8c94]">{sub}</p>}
    </Card>
  );
}

function Stepper({ stage }: { stage: Stage }) {
  const steps: { key: Stage; label: string; hint: string }[] = [
    { key: "upload", label: "Choose a file", hint: "CSV or Excel, from any system" },
    { key: "review", label: "Map and review", hint: "Nothing is written yet" },
    { key: "result", label: "Import", hint: "Rows land in your catalog" },
  ];
  const current = steps.findIndex((step) => step.key === stage);
  return (
    <ol className="mb-6 grid gap-3 sm:grid-cols-3">
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={step.key}
            className={cn(
              "flex items-center gap-3 rounded-[20px] px-4 py-3.5 transition-all duration-200",
              active ? "clay" : "clay-recess",
            )}
          >
            <span
              className={cn(
                "tnum grid size-8 shrink-0 place-items-center rounded-full text-[12px] font-bold",
                done
                  ? "bg-[#17b26a] text-white shadow-[0_4px_12px_rgba(7,148,85,0.3)]"
                  : active
                    ? "gradient-cta text-white shadow-[0_6px_16px_rgba(46,96,120,0.3)]"
                    : "bg-white/70 text-[#7e8c94]",
              )}
            >
              {done ? <Check className="size-4" strokeWidth={3} /> : index + 1}
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  "truncate text-[13px] font-semibold",
                  active || done ? "text-[#2e3e47]" : "text-[#7e8c94]",
                )}
              >
                {step.label}
              </p>
              <p className="truncate text-[11.5px] text-[#7e8c94]">{step.hint}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ==========================================================================
   One row's verdict — errors, duplicate warning, unset terms
   ========================================================================== */
function RowVerdict({ row }: { row: ImportRowVerdict }) {
  const clean = row.errors.length === 0;
  return (
    <div className="space-y-1.5">
      {clean && <StatusPill size="sm" tone="positive" label="Ready" />}
      {row.errors.map((error, index) => (
        <p
          key={`${error.field ?? "row"}-${index}`}
          className="text-[11.5px] leading-snug text-[#b42318]"
        >
          {error.field && (
            <span className="font-semibold">{fieldLabel(error.field)}: </span>
          )}
          {error.message}
        </p>
      ))}
      {(row.is_duplicate_sku || row.missing_terms.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {row.is_duplicate_sku && (
            <StatusPill size="sm" tone="warning" label="Already in your catalog" />
          )}
          {row.missing_terms.map((term) => (
            <StatusPill
              key={term}
              size="sm"
              tone="muted"
              dot={false}
              label={`${fieldLabel(term)} unset`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Recent imports
   ========================================================================== */
function RecentImports() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["imports"],
    queryFn: () => api.listImports(),
  });

  const forbidden = error instanceof ApiError && error.isForbidden;

  return (
    <Panel
      variant="clay"
      className="mt-6"
      icon={<History className="size-4" />}
      title="Recent imports"
      description="Every upload is kept with its verdicts, so an old job can be audited long after the file itself has gone."
      actions={
        !forbidden && (
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw className="size-3.5" />}
            onClick={() => void refetch()}
          >
            Refresh
          </Button>
        )
      }
    >
      {isLoading ? (
        <LoadingBlock rows={2} />
      ) : forbidden ? (
        /* Signed in as a buyer or an admin: not an error, just not yours. */
        <EmptyState
          icon={<History className="size-6" />}
          title="Import history belongs to a vendor account"
          description="This list is scoped to the vendor profile on your token, so there is nothing here to show you."
        />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<FileSpreadsheet className="size-6" />}
          title="No imports yet"
          description="Upload a price list above and it appears here with what it created, updated and skipped."
        />
      ) : (
        <Table minWidth={840}>
          <thead>
            <tr>
              <Th>File</Th>
              <Th>Status</Th>
              <Th>Outcome</Th>
              <Th align="right">Uploaded</Th>
              <Th align="right">Committed</Th>
            </tr>
          </thead>
          <tbody>
            {data.map((job) => (
              <Tr key={job.id}>
                <Td className="max-w-[260px]">
                  <div className="flex items-center gap-2.5">
                    <FileSpreadsheet className="size-4 shrink-0 text-[#93a7b1]" />
                    <span
                      className="truncate font-medium text-[#2e3e47]"
                      title={job.filename}
                    >
                      {job.filename}
                    </span>
                  </div>
                </Td>
                <Td>
                  <StatusPill
                    size="sm"
                    tone={IMPORT_STATUS_TONE[job.status]}
                    label={IMPORT_STATUS_LABEL[job.status]}
                  />
                </Td>
                <Td className="text-[12.5px] text-[#5f7280]">
                  {job.summary_line}
                  {job.error && (
                    <span className="mt-0.5 block text-[11.5px] text-[#b42318]">
                      {job.error}
                    </span>
                  )}
                </Td>
                <Td align="right" className="text-[12.5px] text-[#7e8c94]">
                  <span title={dateTime(job.created_at)}>
                    {relativeTime(job.created_at)}
                  </span>
                </Td>
                <Td align="right" className="text-[12.5px] text-[#7e8c94]">
                  {job.committed_at ? (
                    <span title={dateTime(job.committed_at)}>
                      {relativeTime(job.committed_at)}
                    </span>
                  ) : (
                    "Not committed"
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

/* ==========================================================================
   Page
   ========================================================================== */
export default function VendorImportsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>("upload");
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [commitValidOnly, setCommitValidOnly] = useState(true);
  const [updateExistingSkus, setUpdateExistingSkus] = useState(true);
  const [result, setResult] = useState<ImportCommitResult | null>(null);

  const {
    data: template,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["import-template"],
    queryFn: () => api.importTemplate(),
  });

  /* ------------------------------------------------------------- stage 1 */
  const previewMutation = useMutation({
    mutationFn: (file: File) => api.previewImport(file),
    onSuccess: (data) => {
      const seeded: Record<string, string> = {};
      for (const column of data.detected_columns) seeded[column] = "";
      for (const entry of data.suggested_mapping) {
        seeded[entry.source_column] = entry.target_field;
      }
      setMapping(seeded);
      setSelected(
        new Set(
          data.rows
            .filter((row) => row.errors.length === 0)
            .map((row) => row.row_number),
        ),
      );
      setPreview(data);
      setResult(null);
      setStage("review");
    },
  });

  const acceptFile = (files: FileList | null) => {
    setFileError(null);
    const file = files?.[0];
    if (!file) return;
    if (!/\.(csv|xlsx|xlsm)$/i.test(file.name)) {
      setFileError("Only .csv and .xlsx price lists can be imported.");
      return;
    }
    if (template && file.size > template.max_file_bytes) {
      setFileError(
        `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(
          template.max_file_bytes,
        )} — split it, or export fewer columns.`,
      );
      return;
    }
    previewMutation.mutate(file);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files);
  };

  /* ------------------------------------------------------------- mapping */
  const mappingArray = useMemo<ImportColumnMapping[]>(() => {
    if (!preview) return [];
    return preview.detected_columns
      .filter((column) => Boolean(mapping[column]))
      .map((column) => ({ source_column: column, target_field: mapping[column] }));
  }, [preview, mapping]);

  const mappedTargets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of mappingArray) {
      counts.set(entry.target_field, (counts.get(entry.target_field) ?? 0) + 1);
    }
    return counts;
  }, [mappingArray]);

  const missingRequired = useMemo<ImportTargetField[]>(() => {
    if (!preview) return [];
    return preview.target_fields.filter(
      (field) => field.required && !mappedTargets.has(field.name),
    );
  }, [preview, mappedTargets]);

  const doubleClaimed = useMemo(
    () =>
      [...mappedTargets.entries()]
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    [mappedTargets],
  );

  const mappingDirty = useMemo(() => {
    if (!preview) return false;
    const original = new Map(
      preview.suggested_mapping.map((entry) => [
        entry.source_column,
        entry.target_field,
      ]),
    );
    if (original.size !== mappingArray.length) return true;
    return mappingArray.some(
      (entry) => original.get(entry.source_column) !== entry.target_field,
    );
  }, [preview, mappingArray]);

  /** The value columns the table can show: exactly what `parsed` holds. */
  const valueFields = useMemo<ImportTargetField[]>(() => {
    if (!preview) return [];
    const parsedTargets = new Set(
      preview.suggested_mapping.map((entry) => entry.target_field),
    );
    return preview.target_fields.filter((field) => parsedTargets.has(field.name));
  }, [preview]);

  /* ------------------------------------------------------------- stage 3 */
  const commitMutation = useMutation({
    mutationFn: () => {
      if (!preview) throw new ApiError("There is no preview to import.");
      return api.commitImport(preview.import_job_id, {
        row_numbers: [...selected].sort((a, b) => a - b),
        mapping: mappingArray,
        commit_valid_only: commitValidOnly,
        update_existing_skus: updateExistingSkus,
      });
    },
    onSuccess: (data) => {
      setResult(data);
      setStage("result");
      queryClient.invalidateQueries({ queryKey: ["imports"] });
      queryClient.invalidateQueries({ queryKey: ["catalog"] });
      toast(data.job.summary_line);
    },
  });

  const reset = () => {
    setStage("upload");
    setPreview(null);
    setResult(null);
    setMapping({});
    setSelected(new Set());
    setFileError(null);
    previewMutation.reset();
    commitMutation.reset();
    if (inputRef.current) inputRef.current.value = "";
  };

  const toggleRow = (rowNumber: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  };

  const forbidden = error instanceof ApiError && error.isForbidden;
  const commitFailure = commitMutation.error;
  const commitConflict =
    commitFailure instanceof ApiError && commitFailure.status === 409;
  const selectedRows = preview
    ? preview.rows.filter((row) => selected.has(row.row_number))
    : [];
  const selectedInvalid = selectedRows.filter((row) => row.errors.length > 0).length;
  /**
   * What can actually land: a clean row that is not a SKU the vendor already
   * sells while updating is switched off — the server drops those before it
   * writes, exactly as it drops the invalid ones.
   */
  const selectedCommittable = selectedRows.filter(
    (row) =>
      row.errors.length === 0 && (updateExistingSkus || !row.is_duplicate_sku),
  ).length;

  /**
   * A job commits exactly once — a second attempt answers 409. So a commit
   * that can only write nothing does not just waste a round trip, it spends
   * the job and forces a re-upload. Two cases are certain to write nothing,
   * and both are refused here rather than discovered afterwards:
   *
   *  - a required field has no column, which fails every row. This is read
   *    from the CURRENT mapping, so correcting the mapping clears it.
   *  - not one selected row can land, and the mapping has not been touched
   *    since — with an edited mapping the stored verdicts are stale and the
   *    server may well find those same rows valid, which is the whole point of
   *    being able to correct a mapping without re-uploading.
   */
  const wouldWriteNothing =
    !mappingDirty &&
    commitValidOnly &&
    selectedRows.length > 0 &&
    selectedCommittable === 0;
  const blockReason =
    selected.size === 0
      ? "Select at least one row to import."
      : missingRequired.length > 0
        ? `Map a column to ${missingRequired
            .map((field) => fieldLabel(field.name))
            .join(", ")} first — with it unmapped every row fails and this job is spent.`
        : wouldWriteNothing
          ? "None of the selected rows can land — they either have errors or are SKUs you already sell with updating switched off. Importing would write nothing and still use up this job."
          : null;

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Spreadsheet import"
        description="Bring a price list in from any system. The preview parses and validates every row without touching your catalog — you decide what lands."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {template && (
              <Button
                variant="secondary"
                icon={<Download className="size-4" />}
                onClick={() => downloadText(template.filename, template.csv)}
              >
                Starter CSV
              </Button>
            )}
            {stage !== "upload" && (
              <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={reset}>
                Start over
              </Button>
            )}
          </div>
        }
      />

      <Stepper stage={stage} />

      {isLoading ? (
        <LoadingBlock rows={4} />
      ) : forbidden ? (
        <Alert tone="warning" title="This is the vendor portal">
          Importing writes to a vendor&apos;s own catalog, so the endpoint is
          scoped to a vendor profile derived from your token. Sign in with a
          vendor account to use it.
        </Alert>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !template ? (
        <EmptyState
          icon={<FileSpreadsheet className="size-6" />}
          title="Import is not configured"
          description="The server returned no import template, so there is nothing to map a file against."
        />
      ) : stage === "upload" ? (
        /* ==============================================================
           STAGE 1 — UPLOAD
           ============================================================== */
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
          <Card variant="clay" padded={false} className="p-6 sm:p-8">
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  inputRef.current?.click();
                }
              }}
              role="button"
              tabIndex={0}
              className={cn(
                "clay-recess flex cursor-pointer flex-col items-center justify-center rounded-[24px] border-2 border-dashed px-6 py-14 text-center transition-all duration-200",
                dragging
                  ? "border-[#447f98] bg-[#d6ebf3]"
                  : "border-[#b9d8e1] hover:border-[#629bb5]",
              )}
            >
              <span
                className={cn(
                  "gradient-cta grid size-16 place-items-center rounded-[22px] text-white shadow-[0_14px_28px_rgba(46,96,120,0.28)] transition-transform duration-200",
                  dragging && "scale-105",
                )}
              >
                <UploadCloud className="size-7" strokeWidth={2} />
              </span>
              <p className="mt-5 text-[16px] font-semibold tracking-[-0.02em] text-[#2e3e47]">
                {previewMutation.isPending ? "Reading your file…" : "Drop a price list here"}
              </p>
              <p className="mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-[#5f7280]">
                CSV or Excel, up to {formatBytes(template.max_file_bytes)} and{" "}
                <span className="tnum">{formatNumber(template.max_rows)}</span> rows.
                Your column names do not have to match — the next step maps them.
              </p>
              <Button
                className="mt-5"
                loading={previewMutation.isPending}
                icon={<FileSpreadsheet className="size-4" />}
                onClick={(event) => {
                  event.stopPropagation();
                  inputRef.current?.click();
                }}
              >
                {previewMutation.isPending ? "Validating…" : "Choose a file"}
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.xlsx,.xlsm"
                className="hidden"
                onChange={(event) => {
                  acceptFile(event.target.files);
                  // Clearing the input is what lets the same filename be
                  // chosen again after a rejection — without it the change
                  // event never fires a second time and the picker looks dead.
                  event.target.value = "";
                }}
              />
            </div>

            {fileError && (
              <Alert tone="danger" title="That file cannot be sent" className="mt-5">
                {fileError}
              </Alert>
            )}
            {previewMutation.error && !fileError && (
              <Alert
                tone="danger"
                title="The server could not parse that file"
                className="mt-5"
              >
                {previewMutation.error instanceof Error
                  ? previewMutation.error.message
                  : "Something went wrong reading the upload."}
              </Alert>
            )}

            <Alert tone="brand" className="mt-5" title="Uploading changes nothing">
              The preview parses, maps and validates the file and stores the
              verdicts against an import job. Not one catalog row is created or
              changed until you press Import on the next step.
            </Alert>
          </Card>

          <Panel
            variant="clay"
            icon={<Table2 className="size-4" />}
            title="What the importer looks for"
            description="Four columns are required. The rest are optional and improve how your items score."
            className="xl:sticky xl:top-20"
          >
            <ul className="space-y-3">
              {template.columns.map((column) => (
                <li key={column.name} className="clay-recess rounded-[16px] px-3.5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Mono>{column.name}</Mono>
                    {column.required ? (
                      <Badge tone="danger">Required</Badge>
                    ) : (
                      <Badge tone="muted">Optional</Badge>
                    )}
                    {column.example && (
                      <span className="ml-auto truncate text-[11.5px] text-[#7e8c94]">
                        e.g. {column.example}
                      </span>
                    )}
                  </div>
                  {column.note && (
                    <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#5f7280]">
                      {column.note}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <Button
              full
              variant="secondary"
              className="mt-4"
              icon={<Download className="size-4" />}
              onClick={() => downloadText(template.filename, template.csv)}
            >
              Download the starter CSV
            </Button>
          </Panel>
        </div>
      ) : stage === "review" && preview ? (
        /* ==============================================================
           STAGE 2 — MAP AND REVIEW
           ============================================================== */
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="clay-recess inline-flex items-center gap-2 rounded-full px-3.5 py-1.5">
              <FileSpreadsheet className="size-3.5 text-[#447f98]" />
              <span className="text-[12.5px] font-semibold text-[#2e3e47]">
                {preview.filename}
              </span>
            </span>
            <span className="text-[12px] text-[#7e8c94]">
              Job <Mono>{preview.import_job_id.slice(0, 8)}</Mono> · nothing written yet
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <ClayTile label="Rows read" value={formatNumber(preview.total_rows)} />
            <ClayTile
              label="Valid"
              value={formatNumber(preview.valid_rows)}
              tone={preview.valid_rows > 0 ? "positive" : "muted"}
            />
            <ClayTile
              label="With errors"
              value={formatNumber(preview.invalid_rows)}
              tone={preview.invalid_rows > 0 ? "danger" : "muted"}
            />
            <ClayTile
              label="Duplicate SKUs"
              value={formatNumber(preview.duplicate_rows)}
              tone={preview.duplicate_rows > 0 ? "warning" : "muted"}
              sub="Already in your catalog"
            />
            <ClayTile
              label="Missing terms"
              value={formatNumber(preview.rows_missing_terms)}
              tone={preview.rows_missing_terms > 0 ? "warning" : "muted"}
              sub="No delivery time or warranty"
            />
          </div>

          {preview.truncated && (
            <Alert tone="warning" title="Only part of this file was read">
              The importer previews the first{" "}
              <span className="tnum">{formatNumber(template.max_rows)}</span> rows.
              Anything below that line is not in this job — import these, then
              upload the remainder as a second file.
            </Alert>
          )}

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
            {/* ------------------------------------------------------
                The rail: mapping, options, and the commit action.
                ------------------------------------------------------ */}
            <div className="space-y-5 xl:order-2">
              <Panel
                variant="clay"
                icon={<ArrowLeftRight className="size-4" />}
                title="Column mapping"
                description="Your headers on the left, the importer's fields on the right. Change one and the commit re-validates against it — no re-upload."
              >
                <div className="space-y-2.5">
                  {preview.detected_columns.map((column) => {
                    const target = mapping[column] ?? "";
                    const wasSuggested = preview.suggested_mapping.some(
                      (entry) => entry.source_column === column,
                    );
                    const clash = Boolean(target) && (mappedTargets.get(target) ?? 0) > 1;
                    return (
                      <div
                        key={column}
                        className={cn(
                          "clay-recess rounded-[16px] px-3.5 py-3",
                          clash && "ring-1 ring-[#fecdca]",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className="truncate text-[12.5px] font-semibold text-[#2e3e47]"
                            title={column}
                          >
                            {column}
                          </span>
                          {!wasSuggested && <Badge tone="muted">Not detected</Badge>}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <ArrowRight className="size-3.5 shrink-0 text-[#93a7b1]" />
                          <Select
                            aria-label={`Map the column ${column}`}
                            value={target}
                            onChange={(event) =>
                              setMapping((current) => ({
                                ...current,
                                [column]: event.target.value,
                              }))
                            }
                            className="h-10 bg-white/85"
                          >
                            <option value="">— ignore —</option>
                            {preview.target_fields.map((field) => (
                              <option key={field.name} value={field.name}>
                                {fieldLabel(field.name)}
                                {field.required ? " (required)" : ""}
                              </option>
                            ))}
                          </Select>
                        </div>
                        {clash && (
                          <p className="mt-1.5 text-[11.5px] text-[#b42318]">
                            Two columns point at {fieldLabel(target)}. Only one of them
                            will be read.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>

                {preview.unmapped_columns.length > 0 && (
                  <div className="mt-4 border-t border-[#dce9ef] pt-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                      Not matched automatically
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {preview.unmapped_columns.map((column) => (
                        <Mono key={column}>{column}</Mono>
                      ))}
                    </div>
                    <p className="mt-2 text-[11.5px] leading-relaxed text-[#5f7280]">
                      These are ignored unless you point one at a field above.
                    </p>
                  </div>
                )}

                {missingRequired.length > 0 && (
                  <Alert
                    tone="danger"
                    className="mt-4"
                    title="A required field has no column"
                  >
                    Nothing is mapped to{" "}
                    {missingRequired.map((field) => fieldLabel(field.name)).join(", ")}.
                    Every row fails until you map it.
                  </Alert>
                )}
                {doubleClaimed.length > 0 && missingRequired.length === 0 && (
                  <Alert tone="warning" className="mt-4" title="A field is claimed twice">
                    {doubleClaimed.map((name) => fieldLabel(name)).join(", ")} has more
                    than one source column.
                  </Alert>
                )}
                {mappingDirty && (
                  <Alert tone="brand" className="mt-4" title="Mapping edited">
                    The values in the table are still the ones the detected mapping
                    produced. Your edit takes effect on import, when the server
                    re-validates the stored rows against it.
                  </Alert>
                )}
              </Panel>

              <Panel variant="clay" icon={<ListChecks className="size-4" />} title="Import options">
                <div className="space-y-4">
                  <div className="clay-recess rounded-[16px] px-3.5 py-3">
                    <Switch
                      checked={commitValidOnly}
                      onChange={setCommitValidOnly}
                      label="Partial import"
                    />
                    <p className="mt-2 text-[11.5px] leading-relaxed text-[#5f7280]">
                      On, the valid rows commit and the broken ones come back listed
                      with their reasons. Off, a single bad row rejects the whole
                      file and nothing is written.
                    </p>
                  </div>
                  <div className="clay-recess rounded-[16px] px-3.5 py-3">
                    <Switch
                      checked={updateExistingSkus}
                      onChange={setUpdateExistingSkus}
                      label="Update existing SKUs"
                    />
                    <p className="mt-2 text-[11.5px] leading-relaxed text-[#5f7280]">
                      On, a SKU you already sell is overwritten with the file&apos;s
                      values. Off, it is skipped and reported, so nothing you edited
                      by hand is quietly replaced.
                    </p>
                  </div>
                </div>
              </Panel>

              <Card variant="clay" className="xl:sticky xl:top-20">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[13px] font-semibold text-[#2e3e47]">Ready to import</p>
                  <p className="tnum text-[13px] font-bold text-[#38677b]">
                    {formatNumber(selected.size)} of {formatNumber(preview.total_rows)}
                  </p>
                </div>
                {selectedInvalid > 0 && !commitValidOnly && (
                  <Alert tone="danger" className="mt-3">
                    <span className="tnum">{formatNumber(selectedInvalid)}</span> of the
                    selected rows still have errors and partial import is off, so the
                    server will refuse the whole commit.
                  </Alert>
                )}
                {selectedInvalid > 0 && commitValidOnly && (
                  <p className="mt-2 text-[11.5px] leading-relaxed text-[#b54708]">
                    <span className="tnum">{formatNumber(selectedInvalid)}</span> of them
                    have errors and will be skipped and reported.
                  </p>
                )}
                {commitConflict ? (
                  <Alert tone="warning" className="mt-3" title="Already imported">
                    This job has been committed once already, and a job commits exactly
                    once. Upload the file again to make further changes.
                  </Alert>
                ) : (
                  commitFailure && (
                    <Alert tone="danger" className="mt-3" title="The import was refused">
                      {commitFailure instanceof Error
                        ? commitFailure.message
                        : "Something went wrong."}
                    </Alert>
                  )
                )}
                <Button
                  full
                  size="lg"
                  className="mt-4"
                  loading={commitMutation.isPending}
                  disabled={blockReason !== null}
                  iconRight={<ArrowRight className="size-4" />}
                  onClick={() => commitMutation.mutate()}
                >
                  {commitMutation.isPending
                    ? "Importing…"
                    : `Import ${formatNumber(selected.size)} row${
                        selected.size === 1 ? "" : "s"
                      }`}
                </Button>
                {blockReason ? (
                  <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-[#b54708]">
                    {blockReason}
                  </p>
                ) : (
                  <p className="mt-2.5 text-center text-[11.5px] text-[#7e8c94]">
                    This is the first write of the whole flow.
                  </p>
                )}
              </Card>
            </div>

            {/* ------------------------------------------------------
                The rows
                ------------------------------------------------------ */}
            <Panel
              variant="clay"
              className="min-w-0 xl:order-1"
              icon={<Table2 className="size-4" />}
              title="Rows"
              description={
                preview.rows.length > TABLE_ROW_CAP
                  ? `Showing the first ${TABLE_ROW_CAP} of ${formatNumber(
                      preview.total_rows,
                    )} rows. Selection still applies to every row in the job.`
                  : "Every row, exactly as the validator read it."
              }
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw className="size-3.5" />}
                  onClick={() =>
                    setSelected(
                      new Set(
                        preview.rows
                          .filter((row) => row.errors.length === 0)
                          .map((row) => row.row_number),
                      ),
                    )
                  }
                >
                  Select valid only
                </Button>
              }
            >
              <Table minWidth={280 + valueFields.length * 140}>
                <thead>
                  <tr>
                    <Th className="w-10">
                      <Checkbox
                        checked={selected.size > 0 && selected.size === preview.rows.length}
                        onChange={(next) =>
                          setSelected(
                            next
                              ? new Set(preview.rows.map((row) => row.row_number))
                              : new Set(),
                          )
                        }
                      />
                    </Th>
                    <Th align="right" className="w-12">
                      #
                    </Th>
                    {valueFields.map((field) => (
                      <Th
                        key={field.name}
                        align={NUMERIC_TARGETS.has(field.name) ? "right" : "left"}
                      >
                        {fieldLabel(field.name)}
                      </Th>
                    ))}
                    <Th>Verdict</Th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, TABLE_ROW_CAP).map((row) => {
                    const checked = selected.has(row.row_number);
                    return (
                      <Tr
                        key={row.row_number}
                        className={cn(
                          "transition-colors",
                          checked ? "bg-white/55" : "opacity-75",
                          row.errors.length > 0 && "bg-[#fef3f2]/45",
                        )}
                      >
                        <Td>
                          <Checkbox
                            checked={checked}
                            onChange={() => toggleRow(row.row_number)}
                          />
                        </Td>
                        <Td align="right" className="text-[12px] text-[#7e8c94]">
                          {row.row_number}
                        </Td>
                        {valueFields.map((field) => (
                          <Td
                            key={field.name}
                            align={NUMERIC_TARGETS.has(field.name) ? "right" : "left"}
                            className={cn(
                              "max-w-[220px]",
                              field.name === "sku" && "font-mono text-[12px]",
                            )}
                          >
                            <span className="block truncate">
                              {cellValue(field.name, row.parsed?.[field.name])}
                            </span>
                          </Td>
                        ))}
                        <Td className="min-w-[220px]">
                          <RowVerdict row={row} />
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>

              <div className="mt-5 space-y-2 border-t border-[#dce9ef] pt-4 text-[11.5px] leading-relaxed text-[#5f7280]">
                {preview.rows.length > TABLE_ROW_CAP && (
                  <p>
                    <span className="font-semibold text-[#2e3e47]">
                      The table stops at{" "}
                      <span className="tnum">{formatNumber(TABLE_ROW_CAP)}</span> rows
                    </span>{" "}
                    so a long file cannot lock the page up. All{" "}
                    <span className="tnum">{formatNumber(preview.total_rows)}</span> are
                    in the job, counted in the tiles above, and selected or skipped by the
                    same choices — only the display is shortened.
                  </p>
                )}
                <p>
                  <span className="font-semibold text-[#2e3e47]">Prices</span> appear as
                  plain numbers because a spreadsheet carries no currency of its own.
                  Your vendor profile&apos;s currency is stamped on every item at import.
                </p>
                <p>
                  <span className="font-semibold text-[#2e3e47]">
                    Already in your catalog
                  </span>{" "}
                  means that SKU exists today. It is overwritten or skipped depending on
                  the Update existing SKUs option.
                </p>
                <p>
                  <span className="font-semibold text-[#2e3e47]">Unset terms</span> still
                  import. Buyers then see reduced data confidence on the item and it
                  scores lower, until you fill the terms in on My catalog.
                </p>
              </div>
            </Panel>
          </div>
        </div>
      ) : stage === "result" && result ? (
        /* ==============================================================
           STAGE 3 — RESULT
           ============================================================== */
        <div className="space-y-5">
          <Card variant="clay" className="animate-scale-in">
            <div className="flex flex-wrap items-start gap-4">
              <span
                className={cn(
                  "grid size-12 shrink-0 place-items-center rounded-[18px] text-white",
                  result.job.failed_rows > 0
                    ? "bg-[#f79009] shadow-[0_12px_24px_rgba(247,144,9,0.28)]"
                    : "bg-[#17b26a] shadow-[0_12px_24px_rgba(7,148,85,0.28)]",
                )}
              >
                {result.job.failed_rows > 0 ? (
                  <AlertTriangle className="size-6" />
                ) : (
                  <CheckCircle2 className="size-6" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill
                    tone={IMPORT_STATUS_TONE[result.job.status]}
                    label={IMPORT_STATUS_LABEL[result.job.status]}
                  />
                  <span className="truncate text-[12.5px] text-[#7e8c94]">
                    {result.job.filename}
                  </span>
                </div>
                <p className="mt-2 text-[20px] font-bold tracking-[-0.025em] text-[#2e3e47]">
                  {result.job.summary_line}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Link href="/portal">
                  <Button variant="secondary" iconRight={<ArrowRight className="size-4" />}>
                    Open my catalog
                  </Button>
                </Link>
                <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={reset}>
                  Import another file
                </Button>
              </div>
            </div>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ClayTile
              label="Created"
              value={formatNumber(result.job.created_rows)}
              tone={result.job.created_rows > 0 ? "positive" : "muted"}
              sub="New items in your catalog"
            />
            <ClayTile
              label="Updated"
              value={formatNumber(result.job.updated_rows)}
              tone={result.job.updated_rows > 0 ? "brand" : "muted"}
              sub="SKUs you already sold"
            />
            <ClayTile
              label="Skipped"
              value={formatNumber(result.job.failed_rows)}
              tone={result.job.failed_rows > 0 ? "danger" : "muted"}
              sub="Nothing was written for these"
            />
            <ClayTile
              label="Needing terms"
              value={formatNumber(result.items_needing_terms.length)}
              tone={result.items_needing_terms.length > 0 ? "warning" : "muted"}
              sub="Imported with no delivery or warranty"
            />
          </div>

          <Alert tone="brand" title="Imported items are not live yet">
            Rows land as catalog drafts. Publishing on My catalog is what makes them
            visible to buyers and quotable by the agent.
          </Alert>

          {result.items_needing_terms.length > 0 && (
            <Panel
              variant="clay"
              icon={<AlertTriangle className="size-4" />}
              title="Rows imported without delivery or warranty terms"
              description="These items show reduced data confidence and score lower until the terms are set."
              actions={
                <Link href="/portal">
                  <Button
                    size="sm"
                    variant="secondary"
                    iconRight={<ArrowRight className="size-3.5" />}
                  >
                    Fill them in
                  </Button>
                </Link>
              }
            >
              <div className="flex flex-wrap gap-1.5">
                {result.items_needing_terms.map((rowNumber) => (
                  <span
                    key={rowNumber}
                    className="clay-recess tnum inline-flex items-center rounded-full px-2.5 py-1 text-[11.5px] font-semibold text-[#5f7280]"
                  >
                    Row {rowNumber}
                  </span>
                ))}
              </div>
            </Panel>
          )}

          {result.failed_rows.length > 0 && (
            <Panel
              variant="clay"
              icon={<X className="size-4" />}
              title={`${formatNumber(result.failed_rows.length)} row${
                result.failed_rows.length === 1 ? "" : "s"
              } were not imported`}
              description="Fix these in the source file and upload it again. Everything else is already in your catalog."
            >
              <Table minWidth={720}>
                <thead>
                  <tr>
                    <Th align="right" className="w-12">
                      #
                    </Th>
                    <Th>SKU</Th>
                    <Th>Title</Th>
                    <Th>Why it was skipped</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.failed_rows.map((row) => (
                    <Tr key={row.row_number}>
                      <Td align="right" className="text-[12px] text-[#7e8c94]">
                        {row.row_number}
                      </Td>
                      <Td className="font-mono text-[12px]">
                        {cellValue("sku", row.parsed?.sku)}
                      </Td>
                      <Td className="max-w-[260px]">
                        <span className="block truncate">
                          {cellValue("title", row.parsed?.title)}
                        </span>
                      </Td>
                      <Td className="min-w-[240px]">
                        <RowVerdict row={row} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
          )}
        </div>
      ) : (
        <EmptyState
          icon={<FileSpreadsheet className="size-6" />}
          title="Nothing to show for this step"
          description="The preview was cleared. Start again with a fresh file."
          action={
            <Button icon={<RotateCcw className="size-4" />} onClick={reset}>
              Start over
            </Button>
          }
        />
      )}

      <RecentImports />
    </div>
  );
}
