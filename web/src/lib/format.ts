/**
 * Formatting.
 *
 * Money is the one that matters: the demo currency is PKR and the design
 * writes "PKR 8,700,000" — grouped, no decimals, currency code rather than a
 * symbol. `Intl` with `currencyDisplay: "code"` produces exactly that, and
 * stays correct if an org switches to USD.
 */
import type {
  StepStatus,
  ToolCallStatus,
  VendorStatus,
  WorkflowStatus,
} from "./types";

export type Tone = "neutral" | "brand" | "positive" | "warning" | "danger" | "muted";

/* --------------------------------------------------------------------------
   Money
   -------------------------------------------------------------------------- */
/**
 * Coerce whatever the API actually sent into a number.
 *
 * Most amounts arrive as JSON numbers. `entities_json` is the exception: it is
 * a stored blob, and rows written before the planner's `budget` serializer was
 * fixed hold a Pydantic-rendered Decimal — the STRING "10000000". Those rows
 * are still in the database and still have to render, so every money and
 * number formatter coerces rather than assuming.
 */
export type Numeric = number | string | null | undefined;

function toNumber(value: Numeric): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function money(
  value: Numeric,
  currency = "PKR",
  opts: { decimals?: number; compact?: boolean } = {},
): string {
  const amount = toNumber(value);
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "code",
      minimumFractionDigits: opts.decimals ?? 0,
      maximumFractionDigits: opts.decimals ?? 0,
      notation: opts.compact ? "compact" : "standard",
    })
      .format(amount)
      // Intl emits a non-breaking space after the code; a normal space reads
      // the same and copy-pastes cleanly.
      .replace(/ /g, " ");
  } catch {
    return `${currency} ${amount.toLocaleString("en-US")}`;
  }
}

/** "PKR 8.7M" — for stat tiles where the full figure would wrap. */
export function moneyCompact(value: Numeric, currency = "PKR"): string {
  const amount = toNumber(value);
  if (amount === null) return "—";
  if (Math.abs(amount) < 100_000) return money(amount, currency);
  return money(amount, currency, { compact: true, decimals: 1 });
}

export function number(value: Numeric, decimals = 0): string {
  const parsed = toNumber(value);
  if (parsed === null) return "—";
  return parsed.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Takes a fraction (0.94), renders a percentage ("94%"). */
export function percent(value: Numeric, decimals = 0): string {
  const fraction = toNumber(value);
  if (fraction === null) return "—";
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/** For arithmetic on an amount that may have arrived as a string. */
export function asNumber(value: Numeric): number | null {
  return toNumber(value);
}

/* --------------------------------------------------------------------------
   Time
   -------------------------------------------------------------------------- */
export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dateTime(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (!date) return "—";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function shortDateTime(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (!date) return "—";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function dateOnly(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (!date) return "—";
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function timeOnly(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (!date) return "—";
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** "2 min ago". Coarse on purpose — precision belongs in the tooltip. */
export function relativeTime(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (!date) return "—";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [3600, "minute"],
    [86_400, "hour"],
    [604_800, "day"],
    [2_629_800, "week"],
    [31_557_600, "month"],
  ];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  let previous = 1;
  for (const [limit, unit] of units) {
    if (seconds < limit) {
      return formatter.format(-Math.round(seconds / previous), unit);
    }
    previous = limit;
  }
  return formatter.format(-Math.round(seconds / 31_557_600), "year");
}

/** "8.4s" / "1m 13s" / "214ms" — the scale the run actually took. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/* --------------------------------------------------------------------------
   Status vocabulary — the exact pill copy the design uses
   -------------------------------------------------------------------------- */
export const WORKFLOW_STATUS_LABEL: Record<WorkflowStatus, string> = {
  draft: "Draft",
  running: "In Progress",
  awaiting_approval: "Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
  completed: "Done",
  failed: "Failed",
  escalated: "Needs Attention",
};

export const WORKFLOW_STATUS_TONE: Record<WorkflowStatus, Tone> = {
  draft: "muted",
  running: "brand",
  awaiting_approval: "warning",
  approved: "positive",
  rejected: "danger",
  completed: "positive",
  failed: "danger",
  escalated: "warning",
};

export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: "Pending",
  running: "Running",
  retrying: "Auto-retrying",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

export const STEP_STATUS_TONE: Record<StepStatus, Tone> = {
  pending: "muted",
  running: "brand",
  retrying: "warning",
  completed: "positive",
  failed: "danger",
  skipped: "muted",
};

export const TOOL_STATUS_TONE: Record<ToolCallStatus, Tone> = {
  success: "positive",
  failed: "danger",
  retried: "warning",
  timeout: "danger",
};

export const VENDOR_STATUS_LABEL: Record<VendorStatus, string> = {
  pending: "Pending review",
  verified: "Verified",
  suspended: "Suspended",
  flagged: "Flagged",
};

export const VENDOR_STATUS_TONE: Record<VendorStatus, Tone> = {
  pending: "warning",
  verified: "positive",
  suspended: "danger",
  flagged: "danger",
};

export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  issued: "Issued",
  acknowledged: "Acknowledged",
  in_transit: "In transit",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export const DELIVERY_STATUS_TONE: Record<string, Tone> = {
  issued: "muted",
  acknowledged: "brand",
  in_transit: "brand",
  delivered: "positive",
  cancelled: "danger",
};

export const QUOTE_STATUS_LABEL: Record<string, string> = {
  quoted: "Quoted",
  selected: "Best option",
  excluded_budget: "Exceeds budget",
  excluded_coverage: "Incomplete coverage",
  excluded_stock: "Insufficient stock",
};

/** "excluded_budget" → "Excluded budget". A last resort, not a first choice. */
export function humanise(value: string | null | undefined): string {
  if (!value) return "—";
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function initials(name: string | null | undefined): string {
  if (!name) return "AF";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "AF";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** The scoring criteria, in the order the design stacks the score bar. */
export const CRITERION_LABEL: Record<string, string> = {
  price: "Price",
  delivery: "Delivery",
  warranty: "Warranty",
  reliability: "Reliability",
};

export const CRITERION_COLOR: Record<string, string> = {
  price: "#447f98",
  delivery: "#629bb5",
  warranty: "#b9d8e1",
  reliability: "#38677b",
};
