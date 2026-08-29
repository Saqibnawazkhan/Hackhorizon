"use client";

/**
 * The stacked score bar from screens 5a / 11a.
 *
 * A note the design file forced, and which this component encodes:
 *
 *   Screen 5a's bar widths are not self-consistent — Metro's warranty segment
 *   is drawn wider than TechSupplies' despite half the warranty, and no
 *   monotonic formula produces that. So the widths here are computed from the
 *   real weighted contributions (normalised × weight × 100), which is what the
 *   backend returns in `score.components[].contribution`. Ranking and totals
 *   match the design exactly; the segment widths are honest instead.
 */
import { CRITERION_COLOR, CRITERION_LABEL } from "@/lib/format";
import { cn } from "@/components/ui";
import type { ScoreComponent } from "@/lib/types";

export function ScoreBar({
  components,
  total,
  className,
  height = 10,
  showLegend = true,
}: {
  components: ScoreComponent[];
  total?: number | null;
  className?: string;
  height?: number;
  showLegend?: boolean;
}) {
  const segments = (components ?? []).filter((c) => c.contribution > 0);
  const sum = segments.reduce((acc, c) => acc + c.contribution, 0);
  const scale = total && sum > 0 ? Math.min(total, 100) / sum : 1;

  return (
    <div className={cn("space-y-2", className)}>
      <div
        className="flex w-full overflow-hidden rounded-full bg-[#e7eff3]"
        style={{ height }}
      >
        {segments.map((component) => (
          <div
            key={component.criterion}
            className="h-full transition-[width] duration-700 ease-out first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${component.contribution * scale}%`,
              backgroundColor:
                CRITERION_COLOR[component.criterion] ?? "#629bb5",
              // An imputed value is drawn hatched, so a neutral 0.5 that the
              // vendor never supplied is never mistaken for a measured one.
              backgroundImage: component.was_imputed
                ? "repeating-linear-gradient(45deg, rgba(255,255,255,0.45) 0 3px, transparent 3px 6px)"
                : undefined,
            }}
            title={`${CRITERION_LABEL[component.criterion] ?? component.criterion}: ${component.contribution.toFixed(1)} pts${
              component.was_imputed ? " (imputed — vendor did not specify)" : ""
            }`}
          />
        ))}
      </div>

      {showLegend && segments.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {segments.map((component) => (
            <span
              key={component.criterion}
              className="inline-flex items-center gap-1.5 text-[11px] text-[#5f7280]"
            >
              <span
                className="size-2 rounded-[2px]"
                style={{
                  backgroundColor:
                    CRITERION_COLOR[component.criterion] ?? "#629bb5",
                }}
              />
              {CRITERION_LABEL[component.criterion] ?? component.criterion}
              <span className="font-semibold tabular-nums text-[#243640]">
                {component.contribution.toFixed(1)}
              </span>
              {component.was_imputed && (
                <span className="text-[10px] italic text-[#b54708]">imputed</span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The weight mix, as a compact readout: "Price 50 · Delivery 30 · Warranty 20". */
export function WeightSummary({
  components,
  className,
}: {
  components: ScoreComponent[];
  className?: string;
}) {
  const parts = (components ?? [])
    .filter((c) => c.weight > 0)
    .map(
      (c) =>
        `${CRITERION_LABEL[c.criterion] ?? c.criterion} ${Math.round(c.weight * 100)}%`,
    );
  if (parts.length === 0) return null;
  return (
    <p className={cn("text-[11.5px] text-[#7e8c94]", className)}>
      Weighted on {parts.join(" · ")}
    </p>
  );
}
