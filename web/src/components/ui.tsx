"use client";

/**
 * The shared primitive library.
 *
 * Every screen composes these; no page hard-codes a colour, radius, blur or
 * shadow. That is the same rule the Flutter client follows, and it is what
 * keeps one change landing everywhere at once.
 */
import { clsx, type ClassValue } from "clsx";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Info,
  Loader2,
  X,
} from "lucide-react";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { twMerge } from "tailwind-merge";

import type { Tone } from "@/lib/format";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ==========================================================================
   Tone → colour. One table, so a "warning" looks the same everywhere.
   ========================================================================== */
const TONE_PILL: Record<Tone, string> = {
  neutral: "bg-[#e7eff3] text-[#4a5c66] border-[#d5e3ea]",
  brand: "bg-[#d6ebf3] text-[#38677b] border-[#b9d8e1]",
  positive: "bg-[#ecfdf3] text-[#067647] border-[#a6f4c5]",
  warning: "bg-[#fffaeb] text-[#b54708] border-[#fedf89]",
  danger: "bg-[#fef3f2] text-[#b42318] border-[#fecdca]",
  muted: "bg-white/60 text-[#7e8c94] border-[#e3ebef]",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-[#7e8c94]",
  brand: "bg-[#447f98]",
  positive: "bg-[#17b26a]",
  warning: "bg-[#f79009]",
  danger: "bg-[#f04438]",
  muted: "bg-[#b3c4cc]",
};

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-[#4a5c66]",
  brand: "text-[#447f98]",
  positive: "text-[#067647]",
  warning: "text-[#b54708]",
  danger: "text-[#b42318]",
  muted: "text-[#7e8c94]",
};

export { TONE_DOT, TONE_PILL, TONE_TEXT };

/* ==========================================================================
   Surfaces
   ========================================================================== */
export function Card({
  children,
  className,
  variant = "glass",
  padded = true,
  as: Tag = "div",
}: {
  children?: ReactNode;
  className?: string;
  variant?: "glass" | "soft" | "flat" | "clay" | "plain";
  padded?: boolean;
  as?: "div" | "section" | "article" | "aside" | "li";
}) {
  const surface =
    variant === "glass"
      ? "glass"
      : variant === "soft"
        ? "glass-soft"
        : variant === "flat"
          ? "glass-flat"
          : variant === "clay"
            ? "clay"
            : "bg-white border border-[#e7eff3]";
  return (
    <Tag
      className={cn(
        surface,
        variant === "clay" ? "rounded-[30px]" : "rounded-[28px]",
        padded && "p-6",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** A card with a header row: title, optional description, optional actions. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  variant = "glass",
  icon,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  variant?: "glass" | "soft" | "flat" | "clay" | "plain";
  icon?: ReactNode;
}) {
  return (
    <Card variant={variant} padded={false} className={cn("overflow-hidden", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/60 px-6 pb-4 pt-5">
          <div className="flex min-w-0 items-start gap-3">
            {icon && (
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[12px] bg-white/70 text-[#447f98] shadow-[0_4px_12px_rgba(46,96,120,0.10)]">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              {title && (
                <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-[#243640]">
                  {title}
                </h2>
              )}
              {description && (
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-[#7e8c94]">
                  {description}
                </p>
              )}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("p-6", bodyClassName)}>{children}</div>
    </Card>
  );
}

/* ==========================================================================
   Buttons
   ========================================================================== */
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success" | "subtle";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_BASE =
  "relative inline-flex items-center justify-center gap-2 font-semibold tracking-[-0.01em] " +
  "transition-all duration-200 disabled:pointer-events-none disabled:opacity-45 " +
  "active:translate-y-px select-none whitespace-nowrap";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "gradient-cta text-white shadow-[0_14px_28px_rgba(46,96,120,0.32)] " +
    "hover:shadow-[0_18px_34px_rgba(46,96,120,0.40)] hover:brightness-[1.04]",
  secondary:
    "bg-white/75 text-[#243640] border border-white/80 backdrop-blur-md " +
    "shadow-[0_8px_22px_rgba(46,96,120,0.10)] hover:bg-white/90",
  subtle:
    "bg-[#e9f3f8] text-[#38677b] border border-[#d6ebf3] hover:bg-[#d6ebf3]",
  ghost: "text-[#5f7280] hover:bg-white/70 hover:text-[#243640]",
  danger:
    "bg-[#b42318] text-white shadow-[0_12px_24px_rgba(180,35,24,0.28)] hover:bg-[#a01f15]",
  success:
    "bg-[#17b26a] text-white shadow-[0_12px_24px_rgba(7,148,85,0.28)] hover:bg-[#14a061]",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-[12.5px] rounded-[12px]",
  md: "h-11 px-5 text-[13.5px] rounded-[14px]",
  lg: "h-[52px] px-7 text-[14.5px] rounded-[16px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  full?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    icon,
    iconRight,
    full,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        BUTTON_BASE,
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        full && "w-full",
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        icon
      )}
      {children}
      {!loading && iconRight}
    </button>
  );
});

export function IconButton({
  label,
  icon,
  className,
  variant = "ghost",
  ...rest
}: Omit<ButtonProps, "children" | "size"> & { label: string; icon: ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        BUTTON_BASE,
        BUTTON_VARIANT[variant],
        "size-9 rounded-[12px] p-0",
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}

/* ==========================================================================
   Pills, badges, dots
   ========================================================================== */
export function StatusPill({
  label,
  tone = "neutral",
  dot = true,
  className,
  size = "md",
}: {
  label: ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-semibold tracking-[-0.005em]",
        size === "sm" ? "px-2 py-0.5 text-[10.5px]" : "px-2.5 py-1 text-[11.5px]",
        TONE_PILL[tone],
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />}
      {label}
    </span>
  );
}

export function Badge({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: Tone;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[8px] border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em]",
        TONE_PILL[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A live indicator: a dot that breathes while something is actually running. */
export function LiveDot({ active = true, tone = "brand" as Tone }) {
  return (
    <span className="relative inline-flex size-2">
      <span className={cn("absolute inline-flex size-full rounded-full", TONE_DOT[tone])} />
      {active && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-60",
            TONE_DOT[tone],
          )}
        />
      )}
    </span>
  );
}

/* ==========================================================================
   Form controls
   ========================================================================== */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="flex items-center gap-1 text-[12.5px] font-semibold text-[#4a5c66]"
        >
          {label}
          {required && <span className="text-[#b42318]">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-[11.5px] font-medium text-[#b42318]">{error}</p>
      ) : hint ? (
        <p className="text-[11.5px] leading-relaxed text-[#7e8c94]">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL_BASE =
  "w-full rounded-[14px] border border-white/80 bg-white/70 px-3.5 text-[13.5px] text-[#243640] " +
  "placeholder:text-[#a9bac3] shadow-[inset_0_1px_2px_rgba(46,96,120,0.06)] backdrop-blur-sm " +
  "transition-all duration-200 outline-none " +
  "focus:border-[#447f98]/50 focus:bg-white focus:shadow-[0_0_0_4px_rgba(68,127,152,0.12)] " +
  "disabled:cursor-not-allowed disabled:opacity-55";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          CONTROL_BASE,
          "h-11",
          invalid && "border-[#fecdca] bg-[#fef3f2]/60",
          className,
        )}
        {...rest}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className, invalid, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        CONTROL_BASE,
        "min-h-[110px] resize-y py-3 leading-relaxed",
        invalid && "border-[#fecdca] bg-[#fef3f2]/60",
        className,
      )}
      {...rest}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...rest }, ref) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(CONTROL_BASE, "h-11 appearance-none pr-9", className)}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[#7e8c94]"
        aria-hidden
      />
    </div>
  );
});

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <button
        type="button"
        role="checkbox"
        id={id}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "mt-px grid size-[18px] shrink-0 place-items-center rounded-[6px] border transition-all duration-150",
          checked
            ? "gradient-cta border-transparent text-white shadow-[0_4px_10px_rgba(46,96,120,0.28)]"
            : "border-[#c6d8e0] bg-white/80 hover:border-[#447f98]/60",
          disabled && "opacity-50",
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </button>
      {(label || hint) && (
        <label htmlFor={id} className="cursor-pointer select-none">
          {label && (
            <span className="block text-[13px] font-medium text-[#243640]">{label}</span>
          )}
          {hint && <span className="block text-[11.5px] text-[#7e8c94]">{hint}</span>}
        </label>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2.5 disabled:opacity-50"
    >
      <span
        className={cn(
          "relative h-6 w-11 rounded-full transition-colors duration-200",
          checked
            ? "gradient-cta shadow-[0_4px_12px_rgba(46,96,120,0.3)]"
            : "bg-[#d3e2e9]",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-all duration-200",
            checked ? "left-[22px]" : "left-0.5",
          )}
        />
      </span>
      {label && <span className="text-[13px] text-[#243640]">{label}</span>}
    </button>
  );
}

/** Filter chips — the design's segmented row on 10a / 18a. */
export function ChipGroup<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-all duration-200",
              selected
                ? "gradient-cta border-transparent text-white shadow-[0_6px_16px_rgba(46,96,120,0.26)]"
                : "border-white/80 bg-white/60 text-[#5f7280] hover:bg-white/90 hover:text-[#243640]",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10.5px] tabular-nums",
                  selected ? "bg-white/25" : "bg-[#e7eff3] text-[#5f7280]",
                )}
              >
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ==========================================================================
   Feedback
   ========================================================================== */
export function Alert({
  tone = "brand",
  title,
  children,
  icon,
  className,
  action,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const fallbackIcon =
    tone === "danger" || tone === "warning" ? (
      <AlertTriangle className="size-4" />
    ) : (
      <Info className="size-4" />
    );
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-[20px] border px-4 py-3.5",
        TONE_PILL[tone],
        className,
      )}
      role={tone === "danger" ? "alert" : undefined}
    >
      <span className="mt-px shrink-0">{icon ?? fallbackIcon}</span>
      <div className="min-w-0 flex-1">
        {title && <p className="text-[13px] font-semibold">{title}</p>}
        {children && (
          <div className={cn("text-[12.5px] leading-relaxed", title && "mt-0.5 opacity-90")}>
            {children}
          </div>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-[#447f98]", className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-[14px]", className)} />;
}

export function LoadingBlock({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)}>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton
          key={index}
          className="h-16"
          // Slight width variation reads as content loading, not a broken grid.
        />
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[24px] border border-dashed border-[#cfe0e8] bg-white/40 px-6 py-14 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-4 grid size-14 place-items-center rounded-[18px] bg-white/80 text-[#447f98] shadow-[0_8px_22px_rgba(46,96,120,0.10)]">
          {icon}
        </div>
      )}
      <p className="text-[14.5px] font-semibold text-[#243640]">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-[#7e8c94]">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  return (
    <Alert tone="danger" title="Could not load this" className={className}
      action={
        onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}

/* ==========================================================================
   Progress
   ========================================================================== */
export function ProgressBar({
  value,
  tone = "brand",
  className,
  height = 6,
  animated = false,
}: {
  value: number;
  tone?: Tone;
  className?: string;
  height?: number;
  animated?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className={cn("w-full overflow-hidden rounded-full bg-[#e7eff3]", className)}
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-700 ease-out",
          animated && "running-sweep",
          tone === "brand" && "gradient-cta",
          tone === "positive" && "bg-[#17b26a]",
          tone === "warning" && "bg-[#f79009]",
          tone === "danger" && "bg-[#f04438]",
          tone === "neutral" && "bg-[#7e8c94]",
          tone === "muted" && "bg-[#b3c4cc]",
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/* ==========================================================================
   Data display
   ========================================================================== */
export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
  icon,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Card variant="glass" padded={false} className={cn("p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
          {label}
        </p>
        {icon && (
          <span className={cn("shrink-0", TONE_TEXT[tone])} aria-hidden>
            {icon}
          </span>
        )}
      </div>
      <p
        className={cn(
          "mt-3 text-[28px] font-bold leading-none tracking-[-0.03em] tnum",
          tone === "neutral" ? "text-[#243640]" : TONE_TEXT[tone],
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-2 text-[12px] text-[#7e8c94]">{sub}</p>}
    </Card>
  );
}

export function KeyValue({
  label,
  value,
  className,
  mono,
}: {
  label: ReactNode;
  value: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-2", className)}>
      <dt className="shrink-0 text-[12.5px] text-[#7e8c94]">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-right text-[13px] font-semibold text-[#243640]",
          mono && "font-mono text-[12px] tnum",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/* --- Tables --------------------------------------------------------------- */
export function Table({
  children,
  className,
  minWidth,
}: {
  children: ReactNode;
  className?: string;
  minWidth?: number;
}) {
  return (
    <div className="-mx-6 overflow-x-auto px-6">
      <table
        className={cn("w-full border-collapse text-left", className)}
        style={minWidth ? { minWidth } : undefined}
      >
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  align = "left",
}: {
  children?: ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  return (
    <th
      className={cn(
        "border-b border-[#e0ebf0] pb-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align = "left",
  colSpan,
}: {
  children?: ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        "border-b border-[#eef4f7] py-3 text-[13px] text-[#243640] align-middle",
        align === "right" && "text-right tnum",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        onClick && "cursor-pointer transition-colors hover:bg-white/60",
        className,
      )}
    >
      {children}
    </tr>
  );
}

/* ==========================================================================
   Avatar
   ========================================================================== */
export function Avatar({
  name,
  size = 36,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const label = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <span
      className={cn(
        "gradient-avatar grid shrink-0 place-items-center rounded-full font-semibold text-white shadow-[0_6px_16px_rgba(46,96,120,0.24)]",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden
    >
      {label || "AF"}
    </span>
  );
}

/* ==========================================================================
   Modal
   ========================================================================== */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div
        className="animate-fade-in fixed inset-0 bg-[#16323f]/35 backdrop-blur-[3px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className="animate-scale-in relative my-auto w-full rounded-[28px] border border-white/80 bg-white/92 shadow-[0_24px_56px_rgba(46,96,120,0.22)] backdrop-blur-2xl"
        style={{ maxWidth: width }}
      >
        <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-6">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[17px] font-bold tracking-[-0.02em] text-[#243640]">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-1 text-[12.5px] leading-relaxed text-[#7e8c94]">
                {description}
              </p>
            )}
          </div>
          <IconButton
            label="Close"
            icon={<X className="size-4" />}
            onClick={onClose}
            className="-mr-1 -mt-1"
          />
        </div>
        <div className="max-h-[62vh] overflow-y-auto px-6 pb-2">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-[#eef4f7] px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ==========================================================================
   Toasts
   ========================================================================== */
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<{
  toast: (message: string, tone?: Tone) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, tone: Tone = "positive") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-[60] flex w-[min(380px,calc(100vw-3rem))] flex-col gap-2">
        {toasts.map((item) => (
          <div
            key={item.id}
            className={cn(
              "animate-fade-up pointer-events-auto flex items-start gap-2.5 rounded-[18px] border px-4 py-3 shadow-[0_16px_36px_rgba(46,96,120,0.20)] backdrop-blur-xl",
              TONE_PILL[item.tone],
            )}
            role="status"
          >
            <span className="mt-px shrink-0">
              {item.tone === "danger" || item.tone === "warning" ? (
                <AlertTriangle className="size-4" />
              ) : (
                <Check className="size-4" />
              )}
            </span>
            <p className="text-[12.5px] font-medium leading-relaxed">{item.message}</p>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) return { toast: () => {} };
  return ctx;
}

/* ==========================================================================
   Small helpers
   ========================================================================== */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className="inline-flex items-center gap-1.5 rounded-[8px] px-1.5 py-1 text-[11.5px] font-medium text-[#7e8c94] transition-colors hover:bg-white/70 hover:text-[#447f98]"
      title={label}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        "rounded-[6px] bg-[#e9f3f8] px-1.5 py-0.5 font-mono text-[11.5px] text-[#38677b]",
        className,
      )}
    >
      {children}
    </code>
  );
}

export function Divider({ className, label }: { className?: string; label?: string }) {
  if (label) {
    return (
      <div className={cn("flex items-center gap-3", className)}>
        <span className="h-px flex-1 bg-[#e0ebf0]" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#a9bac3]">
          {label}
        </span>
        <span className="h-px flex-1 bg-[#e0ebf0]" />
      </div>
    );
  }
  return <hr className={cn("border-0 border-t border-[#e7eff3]", className)} />;
}

/** A dl of label/value rows — the shape most detail panes want. */
export function DetailList({
  items,
  className,
  columns = 1,
}: {
  items: { label: ReactNode; value: ReactNode; mono?: boolean }[];
  className?: string;
  columns?: 1 | 2;
}) {
  return (
    <dl
      className={cn(
        columns === 2 ? "grid grid-cols-1 gap-x-8 sm:grid-cols-2" : "divide-y divide-[#eef4f7]",
        className,
      )}
    >
      {items.map((item, index) => (
        <KeyValue
          key={index}
          label={item.label}
          value={item.value}
          mono={item.mono}
          className={columns === 2 ? "border-b border-[#eef4f7]" : undefined}
        />
      ))}
    </dl>
  );
}
