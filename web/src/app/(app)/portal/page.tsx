"use client";

/**
 * Screens 14a / 14b / 14c — the vendor portal's catalog editor.
 *
 * The portal is deliberately a different material from the buyer console:
 * claymorphism (design 14d) rather than liquid glass. Same palette, same type
 * scale, same components — an opaque extruded surface instead of a
 * translucent one, so a vendor always knows which side of the marketplace
 * they are standing on.
 *
 * The model this screen exists to make legible is draft → publish. Every edit
 * here writes immediately (`PATCH /catalog/me/items/{id}`) and sets
 * `has_unpublished_changes`, but a *drafted* row is invisible to everyone
 * else: `GET /catalog/browse` — the same query the agent's `fetch_quotes`
 * runs — filters on `visible AND published_at IS NOT NULL`. So an unpublished
 * price cut does not exist to the agent, and a quote raised before you publish
 * still carries your last published figure. That is the single most important
 * thing a vendor can misunderstand, so the page says it in prose rather than
 * implying it with a badge.
 *
 * One asymmetry worth knowing: the API enforces `sale_price <= price` on
 * create (the validator lives on `CatalogItemBase`) but *not* on update —
 * `CatalogItemUpdate` carries no model validator. The client holds that line
 * on both paths anyway, in both directions, so an inline edit can never leave
 * a row quoting a sale price above its own list price.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Lock,
  Pencil,
  Plus,
  Trash2,
  UploadCloud,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  LoadingBlock,
  Modal,
  Mono,
  Spinner,
  StatusPill,
  Switch,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
  cn,
  useToast,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { money, number, shortDateTime } from "@/lib/format";
import type { CatalogItem, CatalogItemCreate, CatalogItemUpdate } from "@/lib/types";

const PAGE_SIZE = 20;

/** The two terms the catalog serializer can report as unstated. */
const MISSING_TERM_LABEL: Record<string, string> = {
  delivery_days: "a delivery time",
  warranty_months: "a warranty period",
};

/**
 * The clay-recess field treatment.
 *
 * Every class here overrides a specific glass default on the `Input`
 * primitive, and `twMerge` resolves each pair — so the portal gets its own
 * material without forking a shared component.
 */
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

/** "" → null · a usable non-negative number → the number · anything else → undefined. */
function readNumber(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/* ==========================================================================
   Inline-editable cell

   Click to open, Enter or blur to commit, Escape to cancel. The cell owns its
   own edit state, so clicking a second cell commits the first — which is the
   behaviour a spreadsheet trains people to expect.
   ========================================================================== */
function EditableCell({
  value,
  kind,
  currency,
  suffix,
  emptyLabel = "—",
  emptyTone = "muted",
  required = false,
  label,
  validate,
  onCommit,
}: {
  value: number | null;
  kind: "money" | "int";
  currency?: string;
  suffix?: string;
  emptyLabel?: string;
  emptyTone?: "muted" | "warning";
  required?: boolean;
  label: string;
  validate?: (next: number) => string | null;
  onCommit: (next: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Escape and Enter both unmount the input; without this guard the trailing
  // blur would commit a value the user just cancelled.
  const skipBlur = useRef(false);

  const open = () => {
    skipBlur.current = false;
    setDraft(value === null ? "" : String(value));
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    skipBlur.current = true;
    setError(null);
    setEditing(false);
  };

  const commit = () => {
    const raw = draft.trim();

    if (raw === "") {
      if (required) {
        setError(`${label} cannot be blank.`);
        return;
      }
      skipBlur.current = true;
      setEditing(false);
      if (value !== null) onCommit(null);
      return;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setError("Enter a number.");
      return;
    }
    if (parsed < 0) {
      setError(`${label} cannot be negative.`);
      return;
    }
    if (kind === "int" && !Number.isInteger(parsed)) {
      setError("Whole numbers only.");
      return;
    }
    const message = validate?.(parsed) ?? null;
    if (message) {
      setError(message);
      return;
    }

    skipBlur.current = true;
    setEditing(false);
    if (parsed !== value) onCommit(parsed);
  };

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Input
          autoFocus
          inputMode={kind === "int" ? "numeric" : "decimal"}
          aria-label={label}
          aria-invalid={Boolean(error)}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
          onBlur={() => {
            if (skipBlur.current) {
              skipBlur.current = false;
              return;
            }
            commit();
          }}
          className={cn(
            CLAY_FIELD,
            "tnum h-9 w-[108px] px-2.5 text-right text-[12.5px]",
            error && INVALID_FIELD,
          )}
        />
        {error && (
          <p className="max-w-[180px] text-right text-[10.5px] font-semibold leading-snug text-[#b42318]">
            {error}
          </p>
        )}
      </div>
    );
  }

  const display =
    value === null
      ? emptyLabel
      : kind === "money"
        ? money(value, currency)
        : `${number(value)}${suffix ?? ""}`;

  return (
    <button
      type="button"
      onClick={open}
      title={`Edit ${label.toLowerCase()}`}
      className={cn(
        "group/cell tnum inline-flex min-w-[92px] items-center justify-end gap-1.5 rounded-[12px] px-2.5 py-1.5",
        "text-[13px] font-semibold transition-all duration-200",
        "hover:bg-[#ddedf4] hover:shadow-[inset_0_2px_5px_rgba(68,127,152,0.18)]",
        value !== null
          ? "text-[#2e3e47]"
          : emptyTone === "warning"
            ? "text-[#b54708]"
            : "text-[#9db0ba]",
      )}
    >
      <Pencil
        className="size-3 shrink-0 opacity-0 transition-opacity duration-200 group-hover/cell:opacity-55"
        aria-hidden
      />
      {display}
    </button>
  );
}

/* ==========================================================================
   One catalog row
   ========================================================================== */
function CatalogRow({
  item,
  saving,
  onPatch,
  onDelete,
}: {
  item: CatalogItem;
  saving: boolean;
  onPatch: (patch: CatalogItemUpdate, label: string) => void;
  onDelete: () => void;
}) {
  const missing = item.missing_terms
    .map((term) => MISSING_TERM_LABEL[term] ?? term)
    .join(" or ");

  return (
    <Tr className={cn("transition-opacity duration-200", saving && "opacity-55")}>
      <Td className="min-w-[250px] py-3.5 pr-4">
        <p className="text-[13.5px] font-semibold leading-snug text-[#2e3e47]">
          {item.title}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Mono>{item.sku}</Mono>
          {item.has_unpublished_changes && (
            <StatusPill label="Unpublished" tone="warning" size="sm" />
          )}
          {item.stock === 0 ? (
            <StatusPill label="Out of stock" tone="danger" size="sm" />
          ) : item.is_low_stock ? (
            <StatusPill label="Low stock" tone="danger" size="sm" />
          ) : null}
          {saving && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#447f98]">
              <Spinner className="size-3" />
              Saving
            </span>
          )}
        </div>
        {missing && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[11px] font-medium leading-snug text-[#b54708]">
            <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
            <span>
              No {missing} set — the scorer imputes it, and any quote built from
              this item is marked at reduced data confidence.
            </span>
          </p>
        )}
      </Td>

      <Td className="min-w-[130px] pr-4">
        <p className="text-[12.5px] text-[#4a5c66]">{item.category ?? "—"}</p>
        {item.brand && <p className="text-[11.5px] text-[#7e8c94]">{item.brand}</p>}
      </Td>

      <Td align="right" className="pr-2">
        <EditableCell
          value={item.price}
          kind="money"
          currency={item.currency}
          label="Price"
          required
          validate={(next) =>
            item.sale_price !== null && next < item.sale_price
              ? `Cannot fall below the sale price of ${money(item.sale_price, item.currency)}. Lower or clear the sale price first.`
              : null
          }
          onCommit={(next) => onPatch({ price: next ?? undefined }, "Price")}
        />
      </Td>

      <Td align="right" className="pr-2">
        <EditableCell
          value={item.sale_price}
          kind="money"
          currency={item.currency}
          label="Sale price"
          emptyLabel="None"
          validate={(next) =>
            next > item.price
              ? `Cannot exceed the list price of ${money(item.price, item.currency)}.`
              : null
          }
          onCommit={(next) => onPatch({ sale_price: next }, "Sale price")}
        />
      </Td>

      <Td align="right" className="pr-2">
        <EditableCell
          value={item.stock}
          kind="int"
          label="Stock"
          required
          onCommit={(next) => onPatch({ stock: next ?? undefined }, "Stock")}
        />
      </Td>

      <Td align="right" className="pr-2">
        <EditableCell
          value={item.delivery_days}
          kind="int"
          suffix=" days"
          label="Delivery"
          emptyLabel="Not set"
          emptyTone="warning"
          onCommit={(next) => onPatch({ delivery_days: next }, "Delivery time")}
        />
      </Td>

      <Td align="right" className="pr-2">
        <EditableCell
          value={item.warranty_months}
          kind="int"
          suffix=" mo"
          label="Warranty"
          emptyLabel="Not set"
          emptyTone="warning"
          onCommit={(next) => onPatch({ warranty_months: next }, "Warranty")}
        />
      </Td>

      <Td align="center">
        <div className="flex justify-center">
          <Switch
            checked={item.visible}
            onChange={(next) => onPatch({ visible: next }, "Visibility")}
          />
        </div>
      </Td>

      <Td align="right">
        <IconButton
          label={`Remove ${item.title}`}
          icon={<Trash2 className="size-4" />}
          onClick={onDelete}
          className="text-[#93a7b1] hover:text-[#b42318]"
        />
      </Td>
    </Tr>
  );
}

/* ==========================================================================
   Add item — screen 14b
   ========================================================================== */
interface ItemForm {
  sku: string;
  title: string;
  description: string;
  category: string;
  brand: string;
  price: string;
  sale_price: string;
  stock: string;
  delivery_days: string;
  warranty_months: string;
  visible: boolean;
}

const EMPTY_FORM: ItemForm = {
  sku: "",
  title: "",
  description: "",
  category: "",
  brand: "",
  price: "",
  sale_price: "",
  stock: "",
  delivery_days: "",
  warranty_months: "",
  visible: true,
};

function AddItemModal({
  open,
  onClose,
  currency,
}: {
  open: boolean;
  onClose: () => void;
  currency: string | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fieldId = useId();

  const [form, setForm] = useState<ItemForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY_FORM);
    setErrors({});
    setFormError(null);
  }, [open]);

  const set = <K extends keyof ItemForm>(key: K, value: ItemForm[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key as string];
      return next;
    });
  };

  const createMutation = useMutation({
    mutationFn: (body: CatalogItemCreate) => api.createCatalogItem(body),
    onSuccess: (item) => {
      void queryClient.invalidateQueries({ queryKey: ["catalog", "me"] });
      toast(`${item.title} added as a draft. Publish to put it in front of buyers.`);
      onClose();
    },
    onError: (failure) => {
      // A duplicate SKU is a fact about one field, not a page-level failure.
      if (failure instanceof ApiError && failure.status === 409) {
        setErrors({ sku: failure.message });
        return;
      }
      if (failure instanceof ApiError && failure.details.length > 0) {
        const fieldErrors: Record<string, string> = {};
        const general: string[] = [];
        for (const detail of failure.details) {
          if (detail.field && detail.field in EMPTY_FORM) {
            fieldErrors[detail.field] = detail.message;
          } else {
            general.push(detail.message);
          }
        }
        setErrors(fieldErrors);
        setFormError(general.length > 0 ? general.join(" ") : null);
        return;
      }
      setFormError(
        failure instanceof Error ? failure.message : "Could not add this item.",
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);

    const next: Record<string, string> = {};
    const sku = form.sku.trim();
    const title = form.title.trim();
    if (!sku) next.sku = "A SKU is required.";
    if (!title) next.title = "A title is required.";

    const price = readNumber(form.price);
    if (price === undefined) next.price = "Enter an amount of zero or more.";
    else if (price === null) next.price = "A price is required.";

    const stock = readNumber(form.stock);
    if (stock === undefined || (stock !== null && !Number.isInteger(stock))) {
      next.stock = "Enter a whole number of units.";
    } else if (stock === null) {
      next.stock = "A stock quantity is required.";
    }

    const salePrice = readNumber(form.sale_price);
    if (salePrice === undefined) {
      next.sale_price = "Enter an amount of zero or more.";
    } else if (salePrice !== null && typeof price === "number" && salePrice > price) {
      next.sale_price = "The sale price must not exceed the list price.";
    }

    const deliveryDays = readNumber(form.delivery_days);
    if (deliveryDays === undefined || (deliveryDays !== null && !Number.isInteger(deliveryDays))) {
      next.delivery_days = "Enter a whole number of days.";
    }

    const warrantyMonths = readNumber(form.warranty_months);
    if (
      warrantyMonths === undefined ||
      (warrantyMonths !== null && !Number.isInteger(warrantyMonths))
    ) {
      next.warranty_months = "Enter a whole number of months.";
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;
    if (typeof price !== "number" || typeof stock !== "number") return;

    createMutation.mutate({
      sku,
      title,
      description: form.description.trim() || null,
      category: form.category.trim() || null,
      brand: form.brand.trim() || null,
      price,
      sale_price: salePrice ?? null,
      stock,
      delivery_days: deliveryDays ?? null,
      warranty_months: warrantyMonths ?? null,
      visible: form.visible,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={720}
      title="Add a catalog item"
      description="It arrives as a draft. Publish to make it readable by buyers and by the agent."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={createMutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={`${fieldId}-form`}
            loading={createMutation.isPending}
            icon={<Plus className="size-4" />}
          >
            Add item
          </Button>
        </>
      }
    >
      <form id={`${fieldId}-form`} onSubmit={submit} className="space-y-5 pb-4">
        <p className="clay-recess rounded-[18px] px-4 py-3 text-[12.5px] leading-relaxed text-[#4a5c66]">
          Leave <strong className="font-semibold text-[#2e3e47]">delivery time</strong> or{" "}
          <strong className="font-semibold text-[#2e3e47]">warranty</strong> empty and the item
          inherits your vendor profile defaults. If the profile has none either, the item ships
          without those terms and every quote built from it scores at reduced data confidence.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="SKU"
            required
            htmlFor={`${fieldId}-sku`}
            error={errors.sku}
            hint={errors.sku ? undefined : "Unique within your catalog."}
          >
            <Input
              id={`${fieldId}-sku`}
              value={form.sku}
              aria-invalid={Boolean(errors.sku)}
              onChange={(event) => set("sku", event.target.value)}
              placeholder="LAP-X1C-14"
              className={cn(CLAY_FIELD, errors.sku && INVALID_FIELD)}
            />
          </Field>

          <Field label="Title" required htmlFor={`${fieldId}-title`} error={errors.title}>
            <Input
              id={`${fieldId}-title`}
              value={form.title}
              aria-invalid={Boolean(errors.title)}
              onChange={(event) => set("title", event.target.value)}
              placeholder="ThinkPad X1 Carbon Gen 12"
              className={cn(CLAY_FIELD, errors.title && INVALID_FIELD)}
            />
          </Field>
        </div>

        <Field label="Description" htmlFor={`${fieldId}-description`}>
          <Textarea
            id={`${fieldId}-description`}
            value={form.description}
            onChange={(event) => set("description", event.target.value)}
            placeholder="Specification the buyer's request text will be matched against."
            className={cn(CLAY_FIELD, "min-h-[84px]")}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category" htmlFor={`${fieldId}-category`}>
            <Input
              id={`${fieldId}-category`}
              value={form.category}
              onChange={(event) => set("category", event.target.value)}
              placeholder="Laptops"
              className={CLAY_FIELD}
            />
          </Field>
          <Field label="Brand" htmlFor={`${fieldId}-brand`}>
            <Input
              id={`${fieldId}-brand`}
              value={form.brand}
              onChange={(event) => set("brand", event.target.value)}
              placeholder="Lenovo"
              className={CLAY_FIELD}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Price"
            required
            htmlFor={`${fieldId}-price`}
            error={errors.price}
            hint={errors.price ? undefined : currency ? `Amount in ${currency}.` : undefined}
          >
            <Input
              id={`${fieldId}-price`}
              inputMode="decimal"
              value={form.price}
              aria-invalid={Boolean(errors.price)}
              onChange={(event) => set("price", event.target.value)}
              placeholder="285000"
              className={cn(CLAY_FIELD, "tnum", errors.price && INVALID_FIELD)}
            />
          </Field>
          <Field label="Sale price" htmlFor={`${fieldId}-sale`} error={errors.sale_price}>
            <Input
              id={`${fieldId}-sale`}
              inputMode="decimal"
              value={form.sale_price}
              aria-invalid={Boolean(errors.sale_price)}
              onChange={(event) => set("sale_price", event.target.value)}
              placeholder="Optional"
              className={cn(CLAY_FIELD, "tnum", errors.sale_price && INVALID_FIELD)}
            />
          </Field>
          <Field label="Stock" required htmlFor={`${fieldId}-stock`} error={errors.stock}>
            <Input
              id={`${fieldId}-stock`}
              inputMode="numeric"
              value={form.stock}
              aria-invalid={Boolean(errors.stock)}
              onChange={(event) => set("stock", event.target.value)}
              placeholder="40"
              className={cn(CLAY_FIELD, "tnum", errors.stock && INVALID_FIELD)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Delivery time (days)"
            htmlFor={`${fieldId}-delivery`}
            error={errors.delivery_days}
          >
            <Input
              id={`${fieldId}-delivery`}
              inputMode="numeric"
              value={form.delivery_days}
              aria-invalid={Boolean(errors.delivery_days)}
              onChange={(event) => set("delivery_days", event.target.value)}
              placeholder="Inherit profile default"
              className={cn(CLAY_FIELD, "tnum", errors.delivery_days && INVALID_FIELD)}
            />
          </Field>
          <Field
            label="Warranty (months)"
            htmlFor={`${fieldId}-warranty`}
            error={errors.warranty_months}
          >
            <Input
              id={`${fieldId}-warranty`}
              inputMode="numeric"
              value={form.warranty_months}
              aria-invalid={Boolean(errors.warranty_months)}
              onChange={(event) => set("warranty_months", event.target.value)}
              placeholder="Inherit profile default"
              className={cn(CLAY_FIELD, "tnum", errors.warranty_months && INVALID_FIELD)}
            />
          </Field>
        </div>

        <div className="clay-recess flex flex-wrap items-center justify-between gap-3 rounded-[18px] px-4 py-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-[#2e3e47]">Visible to buyers</p>
            <p className="text-[11.5px] leading-relaxed text-[#5f7280]">
              Hidden items stay in your catalog but are never matched by the agent.
            </p>
          </div>
          <Switch checked={form.visible} onChange={(next) => set("visible", next)} />
        </div>

        {formError && (
          <p className="rounded-[14px] border border-[#fecdca] bg-[#fef3f2] px-3.5 py-2.5 text-[12.5px] font-medium text-[#b42318]">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  );
}

/* ==========================================================================
   Small pieces
   ========================================================================== */
function RecessStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  tone?: "neutral" | "warning";
}) {
  return (
    <div className="clay-recess rounded-[18px] px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
        {label}
      </p>
      <p
        className={cn(
          "tnum mt-1 text-[22px] font-bold leading-none tracking-[-0.03em]",
          tone === "warning" ? "text-[#b54708]" : "text-[#2e3e47]",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/* ==========================================================================
   Page
   ========================================================================== */
export default function VendorCatalogPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [offset, setOffset] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CatalogItem | null>(null);

  const catalogQuery = useQuery({
    queryKey: ["catalog", "me", offset],
    queryFn: () => api.myCatalog({ limit: PAGE_SIZE, offset }),
    placeholderData: keepPreviousData,
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; patch: CatalogItemUpdate; label: string }) =>
      api.updateCatalogItem(input.id, input.patch),
    onSuccess: (_item, input) => {
      void queryClient.invalidateQueries({ queryKey: ["catalog", "me"] });
      toast(`${input.label} saved as a draft change. Publish to make it live.`);
    },
    onError: (failure) => {
      toast(
        failure instanceof Error ? failure.message : "Could not save that change.",
        "danger",
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteCatalogItem(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["catalog", "me"] });
      toast("Item removed from your catalog.");
      setPendingDelete(null);
    },
    onError: (failure) => {
      toast(
        failure instanceof Error ? failure.message : "Could not remove that item.",
        "danger",
      );
    },
  });

  const publishMutation = useMutation({
    mutationFn: () => api.publishCatalog(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["catalog", "me"] });
      toast(
        result.published_count === 0
          ? "Nothing needed publishing."
          : `Published ${number(result.published_count)} ${plural(result.published_count, "item", "items")} at ${shortDateTime(result.published_at)}. Buyers and the agent can read them now.`,
      );
    },
    onError: (failure) => {
      toast(
        failure instanceof Error ? failure.message : "Could not publish your changes.",
        "danger",
      );
    },
  });

  const data = catalogQuery.data;
  const draft = data?.draft_state;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const unsaved = draft?.unsaved_change_count ?? 0;
  const missingTerms = draft?.items_missing_terms ?? 0;
  const currency = items[0]?.currency ?? null;
  const savingId = updateMutation.isPending ? updateMutation.variables?.id : null;

  const forbidden = catalogQuery.error instanceof ApiError && catalogQuery.error.isForbidden;

  const header = (
    <PageHeader
      title="My catalog"
      description="Your prices, stock and terms. Edits are drafts until you publish them."
      actions={
        forbidden ? undefined : (
          <>
            <Button
              variant="secondary"
              icon={<Plus className="size-4" />}
              onClick={() => setAddOpen(true)}
            >
              Add item
            </Button>
            <Button
              variant={unsaved > 0 ? "primary" : "secondary"}
              disabled={unsaved === 0}
              loading={publishMutation.isPending}
              icon={<UploadCloud className="size-4" />}
              onClick={() => publishMutation.mutate()}
            >
              {unsaved > 0
                ? `Publish ${number(unsaved)} ${plural(unsaved, "change", "changes")}`
                : "Nothing to publish"}
            </Button>
          </>
        )
      }
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
                . Every catalog query is scoped to the vendor the signed-in identity owns — never
                to a vendor id sent by the client — so without that link there is no catalog to
                show. An administrator links a vendor record to a portal account.
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

      {/* -- Draft state and what publishing means --------------------------- */}
      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card variant="clay" className="animate-fade-up lg:col-span-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            Draft state
          </p>

          {catalogQuery.isLoading ? (
            <div className="mt-3 space-y-3">
              <div className="skeleton h-5 w-2/3 rounded-[10px]" />
              <div className="grid grid-cols-2 gap-3">
                <div className="skeleton h-16 rounded-[18px]" />
                <div className="skeleton h-16 rounded-[18px]" />
              </div>
            </div>
          ) : catalogQuery.error ? (
            // Without the catalog there is no draft state. Rendering the zeros
            // would assert "everything is published", which is a claim about
            // your live listings that nothing here can stand behind.
            <p className="mt-3 text-[12.5px] leading-relaxed text-[#5f7280]">
              Your draft state could not be read, so no figures are shown rather
              than figures that might be wrong. The reason, and a retry, are on
              the panel below.
            </p>
          ) : (
            <>
              {/* status_line is composed server-side; it is rendered verbatim. */}
              <p className="mt-2 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-[#2e3e47]">
                {draft?.status_line ?? "—"}
              </p>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <RecessStat
                  label="Unsaved changes"
                  value={number(unsaved)}
                  tone={unsaved > 0 ? "warning" : "neutral"}
                />
                <RecessStat
                  label="Items missing terms"
                  value={number(missingTerms)}
                  tone={missingTerms > 0 ? "warning" : "neutral"}
                />
              </div>

              <p className="mt-4 text-[12.5px] leading-relaxed text-[#5f7280]">
                {unsaved > 0 ? (
                  <>
                    {number(unsaved)} {plural(unsaved, "item is", "items are")} edited but not yet
                    published. Buyers and the agent still see the previously published figures.
                  </>
                ) : (
                  <>Everything in your catalog is published. Buyers and the agent see it as it is.</>
                )}
                {missingTerms > 0 && (
                  <>
                    {" "}
                    {number(missingTerms)}{" "}
                    {plural(missingTerms, "item has", "items have")} no delivery time or warranty;
                    the scorer imputes those values and marks the affected quotes at reduced data
                    confidence.
                  </>
                )}
              </p>
            </>
          )}
        </Card>

        <Card variant="clay" className="animate-fade-up">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-[14px] bg-[#ddedf4] text-[#38677b] shadow-[inset_0_2px_5px_rgba(68,127,152,0.22)]">
              <UploadCloud className="size-4" />
            </span>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#2e3e47]">
              What publishing does
            </h2>
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-[#5f7280]">
            Only items that are <strong className="font-semibold text-[#2e3e47]">published</strong>{" "}
            and <strong className="font-semibold text-[#2e3e47]">visible</strong> can be read by
            buyers browsing catalogs — and by the agent when it gathers quotes. Everything you
            change here is a draft first: an unpublished price change simply does not exist to the
            agent yet, and a workflow that runs in the meantime will quote your last published
            figure.
          </p>
        </Card>
      </div>

      {/* -- The catalog ------------------------------------------------------ */}
      <Card variant="clay" padded={false} className="animate-fade-up">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/70 px-6 pb-4 pt-5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#2e3e47]">
              Items
            </h2>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-[#7e8c94]">
              Click a price, stock or terms cell to edit it. Enter saves, Escape cancels.
            </p>
          </div>
          {total > 0 && (
            <p className="tnum text-[12px] font-semibold text-[#7e8c94]">
              {number(total)} {plural(total, "item", "items")}
            </p>
          )}
        </div>

        <div className="px-6 pb-5 pt-4">
          {catalogQuery.isLoading ? (
            <LoadingBlock rows={6} />
          ) : catalogQuery.error ? (
            <ErrorState error={catalogQuery.error} onRetry={() => void catalogQuery.refetch()} />
          ) : items.length === 0 ? (
            offset > 0 ? (
              // Past the end — items were removed from under this page. "Your
              // catalog is empty" here would be a claim about the whole catalog.
              <EmptyState
                icon={<Boxes className="size-6" />}
                title="Nothing left on this page"
                description="Items were removed while you were reading them. The rest of your catalog is on the earlier pages."
                action={
                  <Button variant="secondary" onClick={() => setOffset(0)}>
                    Back to the first page
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Boxes className="size-6" />}
                title="Your catalog is empty"
                description="The agent can only quote you on items it can read. Add your first item, fill in its delivery time and warranty, then publish."
                action={
                  <Button icon={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>
                    Add item
                  </Button>
                }
              />
            )
          ) : (
            <>
              <Table minWidth={1180}>
                <thead>
                  <Tr>
                    <Th>Item</Th>
                    <Th>Category</Th>
                    <Th align="right">Price</Th>
                    <Th align="right">Sale price</Th>
                    <Th align="right">Stock</Th>
                    <Th align="right">Delivery</Th>
                    <Th align="right">Warranty</Th>
                    <Th align="center">Visible</Th>
                    <Th align="right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </Tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <CatalogRow
                      key={item.id}
                      item={item}
                      saving={savingId === item.id}
                      onPatch={(patch, label) =>
                        updateMutation.mutate({ id: item.id, patch, label })
                      }
                      onDelete={() => setPendingDelete(item)}
                    />
                  ))}
                </tbody>
              </Table>

              {total > PAGE_SIZE && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
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
        </div>
      </Card>

      <AddItemModal open={addOpen} onClose={() => setAddOpen(false)} currency={currency} />

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        width={460}
        title="Remove this item?"
        description="It disappears from your catalog immediately, and from buyer browse and agent quotes at once."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleteMutation.isPending}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={deleteMutation.isPending}
              icon={<Trash2 className="size-4" />}
              onClick={() => {
                if (pendingDelete) deleteMutation.mutate(pendingDelete.id);
              }}
            >
              Remove item
            </Button>
          </>
        }
      >
        {pendingDelete && (
          <div className="clay-recess mb-4 rounded-[18px] px-4 py-3">
            <p className="text-[13.5px] font-semibold text-[#2e3e47]">{pendingDelete.title}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Mono>{pendingDelete.sku}</Mono>
              <span className="tnum text-[12.5px] font-semibold text-[#4a5c66]">
                {money(pendingDelete.effective_price, pendingDelete.currency)}
              </span>
              <span className="tnum text-[12px] text-[#7e8c94]">
                {number(pendingDelete.stock)} in stock
              </span>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
