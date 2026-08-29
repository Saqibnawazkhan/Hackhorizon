"use client";

/**
 * Scoring weights.
 *
 * This screen is the proof that "the weights are admin-configurable" is a
 * fact rather than an aspiration: the four numbers set here are read by the
 * scoring engine on the next scored run, with no redeploy and no code change.
 *
 * The sum must be exactly 1.0. That is enforced twice on the server — by the
 * Pydantic validator and by a Postgres CHECK constraint — so a partial update
 * cannot leave scoring in an invalid state. Rather than let the API reject the
 * save, the page holds Save closed until the mix balances and says by how much
 * it is off.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Info,
  RotateCcw,
  Save,
  Scale,
  SlidersHorizontal,
  Wand2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Button,
  CopyButton,
  ErrorState,
  LoadingBlock,
  Mono,
  Panel,
  cn,
  useToast,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { CRITERION_COLOR, CRITERION_LABEL, percent } from "@/lib/format";
import type { ScoringWeights } from "@/lib/types";

const CRITERIA = ["price", "delivery", "warranty", "reliability"] as const;
type Criterion = (typeof CRITERIA)[number];
type WeightMap = Record<Criterion, number>;

/**
 * Anything inside this of 1.0 counts as balanced — float addition is not exact.
 *
 * The figure matches the server's own check (`abs(total - 1.0) > 1e-6` in the
 * Pydantic validator) exactly. A looser gate here would let the page promise
 * "this mix will be accepted" for a mix the API then rejects with a 422.
 */
const TOLERANCE = 1e-6;

const CRITERION_HINT: Record<Criterion, string> = {
  price:
    "Lowest total wins. Each offer is normalised against the cheapest quote on the table, not against an absolute figure.",
  delivery:
    "Fewest days wins, normalised across the offers actually returned for this request.",
  warranty: "Longest cover wins. Quotes with no stated warranty score zero here.",
  reliability:
    "Derived from delivered-order history. A vendor below the minimum order count has no score, so this component is imputed and flagged as imputed in the breakdown.",
};

const PRESETS: { name: string; note: string; weights: WeightMap }[] = [
  {
    name: "Design default",
    note: "The mix the comparison screen was designed around.",
    weights: { price: 0.5, delivery: 0.3, warranty: 0.2, reliability: 0 },
  },
  {
    name: "Speed first",
    note: "Delivery outranks price — for deadline-bound requests.",
    weights: { price: 0.3, delivery: 0.5, warranty: 0.2, reliability: 0 },
  },
  {
    name: "Trusted suppliers",
    note: "Gives fulfilment history a quarter of the decision.",
    weights: { price: 0.35, delivery: 0.25, warranty: 0.15, reliability: 0.25 },
  },
];

/** The four numbers, coerced so a malformed value cannot poison the maths. */
function readWeights(data: ScoringWeights): WeightMap {
  return {
    price: Number(data.price) || 0,
    delivery: Number(data.delivery) || 0,
    warranty: Number(data.warranty) || 0,
    reliability: Number(data.reliability) || 0,
  };
}

function sumOf(weights: WeightMap): number {
  return CRITERIA.reduce((total, criterion) => total + weights[criterion], 0);
}

function sameAs(a: WeightMap, b: WeightMap): boolean {
  return CRITERIA.every((criterion) => Math.abs(a[criterion] - b[criterion]) < 1e-9);
}

/** Scale to 1.0, letting the largest criterion absorb the rounding remainder. */
function normalise(weights: WeightMap): WeightMap {
  const total = sumOf(weights);
  if (total <= 0) return weights;
  const round = (value: number) => Math.round((value / total) * 10_000) / 10_000;
  const scaled: WeightMap = {
    price: round(weights.price),
    delivery: round(weights.delivery),
    warranty: round(weights.warranty),
    reliability: round(weights.reliability),
  };
  // Four values rounded independently need not land on exactly 1.0, and the
  // server refuses anything further than 1e-6 from it. The remainder goes on
  // the largest weight, which is at least a quarter of the mix and can always
  // absorb it — putting it on a fixed criterion could drive that one negative.
  const largest = CRITERIA.reduce((best, criterion) =>
    scaled[criterion] > scaled[best] ? criterion : best,
  );
  const remainder = Math.round((1 - sumOf(scaled)) * 10_000) / 10_000;
  scaled[largest] = Math.round((scaled[largest] + remainder) * 10_000) / 10_000;
  return scaled;
}

export default function ScoringWeightsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin", "scoring-weights"],
    queryFn: () => api.getScoringWeights(),
  });

  const [draft, setDraft] = useState<WeightMap | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saved = useMemo(() => (data ? readWeights(data) : null), [data]);
  // Render the saved values immediately; the draft takes over on first edit,
  // so the editor never flashes an empty frame between fetch and effect.
  const current = draft ?? saved;

  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  const mutation = useMutation({
    mutationFn: (weights: WeightMap) => api.setScoringWeights(weights),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "scoring-weights"] });
      setSaveError(null);
      toast("Weights saved. The next scored run uses them.", "positive");
    },
    onError: (failure: unknown) => {
      // A 422 from the sum validator carries the useful prose in `details`;
      // the envelope's own message is the generic "The request body or
      // parameters failed validation.", which explains nothing on its own.
      const detail =
        failure instanceof ApiError && failure.details.length > 0
          ? failure.details.map((item) => item.message).join(" ")
          : null;
      const message =
        failure instanceof Error ? failure.message : "Could not save the weights.";
      setSaveError(detail ? `${message} ${detail}` : message);
      toast(detail ?? message, "danger");
    },
  });

  const total = current ? sumOf(current) : 0;
  const delta = total - 1;
  const balanced = Math.abs(delta) <= TOLERANCE;
  const dirty = Boolean(current && saved && !sameAs(current, saved));
  const unconfigured = Boolean(current) && total === 0;
  const isDefault = data?.is_default === true;
  // While the org is on the environment fallbacks there is no stored row, so
  // saving the mix exactly as shown is a real act — it writes the override the
  // side panel promises. Requiring an edit first would contradict that copy.
  const savable = Boolean(current) && balanced && (dirty || isDefault);
  const notLinkedToOrg =
    mutation.error instanceof ApiError && mutation.error.status === 400;
  const forbidden =
    mutation.error instanceof ApiError && mutation.error.isForbidden;

  const setCriterion = (criterion: Criterion, value: number) => {
    // A range input can report 0.15000000000000002 rather than 0.15. Four
    // decimal places is the precision the column stores anyway, and keeping
    // the draft there is what lets a preset compare equal to itself.
    const rounded = Math.round(value * 10_000) / 10_000;
    setDraft((previous) => {
      const base = previous ?? saved;
      return base ? { ...base, [criterion]: rounded } : base;
    });
    setSaveError(null);
  };

  return (
    <>
      <PageHeader
        title="Scoring weights"
        description="How the agent trades price against delivery, warranty and supplier reliability when it ranks quotes. Every scored run reads these four numbers; changing them changes the next decision, not the ones already recorded."
        actions={
          <>
            {dirty && (
              <Button
                variant="ghost"
                size="sm"
                icon={<RotateCcw className="size-3.5" />}
                onClick={() => {
                  if (saved) setDraft(saved);
                  setSaveError(null);
                }}
              >
                Discard changes
              </Button>
            )}
            <Button
              icon={<Save className="size-4" />}
              loading={mutation.isPending}
              disabled={!savable}
              onClick={() => {
                if (current) mutation.mutate(current);
              }}
            >
              Save weights
            </Button>
          </>
        }
      />

      {isLoading ? (
        <LoadingBlock rows={4} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !current ? (
        <Alert tone="warning" title="No weighting returned">
          The API answered without any weights. Reload to try again — until it
          does, scoring falls back to the environment configuration.
        </Alert>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* ------------------------------------------------------------
              The editor
              ------------------------------------------------------------ */}
          <div className="space-y-4 lg:col-span-2">
            {/* A failed save belongs beside the editor, not in the sidebar:
                on one column the sidebar sits below the whole editor, which
                would put the explanation off-screen. */}
            {saveError && (
              <Alert
                tone="danger"
                title={
                  notLinkedToOrg
                    ? "Nowhere to save these"
                    : forbidden
                      ? "Administrators only"
                      : "Save failed"
                }
              >
                <p>{saveError}</p>
                {notLinkedToOrg && (
                  <p className="mt-2 opacity-90">
                    Weights are stored per organisation. Until this account is
                    linked to one, scoring keeps using the environment
                    fallbacks and there is no row to write.
                  </p>
                )}
              </Alert>
            )}
            {unconfigured && (
              <Alert tone="warning" title="Nothing is weighted yet">
                Every criterion came back at zero, so no quote can be ranked.
                Pick a preset below, or set the four sliders so they sum to
                100%, then save.
              </Alert>
            )}
            <Panel
              className="animate-fade-up"
              icon={<SlidersHorizontal className="size-4" />}
              title="The weighting mix"
              description="Drag a criterion up and the others must give way — the four have to sum to exactly 1.0."
            >
              {/* Live stacked preview: the mix as one shape */}
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                  Live preview
                </span>
                <span className="text-[11px] text-[#7e8c94] tnum">
                  {balanced
                    ? "The mix sums to 100%"
                    : `The mix sums to ${percent(total, 1)}`}
                </span>
              </div>
              <div className="flex h-4 w-full overflow-hidden rounded-full bg-[#e7eff3]">
                {CRITERIA.map((criterion) => {
                  const width =
                    (current[criterion] / Math.max(total, 1)) * 100;
                  if (width <= 0) return null;
                  return (
                    <div
                      key={criterion}
                      className="h-full transition-[width] duration-200 ease-out"
                      style={{
                        width: `${width}%`,
                        backgroundColor: CRITERION_COLOR[criterion],
                      }}
                      title={`${CRITERION_LABEL[criterion]} ${percent(current[criterion])}`}
                    />
                  );
                })}
              </div>

              {/* The four sliders */}
              <div className="mt-5 space-y-3">
                {CRITERIA.map((criterion) => (
                  <div
                    key={criterion}
                    className="rounded-[20px] border border-white/70 bg-white/55 p-4 transition-colors duration-200 hover:bg-white/75"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <label
                        htmlFor={`weight-${criterion}`}
                        className="flex items-center gap-2 text-[13.5px] font-semibold text-[#243640]"
                      >
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: CRITERION_COLOR[criterion] }}
                          aria-hidden
                        />
                        {CRITERION_LABEL[criterion]}
                      </label>
                      <span className="text-[17px] font-bold tracking-[-0.02em] text-[#243640] tnum">
                        {percent(current[criterion])}
                      </span>
                    </div>
                    <input
                      id={`weight-${criterion}`}
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={current[criterion]}
                      onChange={(event) =>
                        setCriterion(criterion, Number(event.target.value))
                      }
                      style={{ accentColor: "#447f98" }}
                      className="mt-3 w-full cursor-pointer"
                    />
                    <p className="mt-2 text-[11.5px] leading-relaxed text-[#7e8c94]">
                      {CRITERION_HINT[criterion]}
                    </p>
                  </div>
                ))}
              </div>

              {/* The running total — the gate on Save */}
              <div
                className={cn(
                  "mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[20px] border px-4 py-3.5",
                  balanced
                    ? "border-[#a6f4c5] bg-[#ecfdf3]"
                    : "border-[#fedf89] bg-[#fffaeb]",
                )}
              >
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                    Total
                  </p>
                  <p
                    className={cn(
                      "text-[26px] font-bold leading-none tracking-[-0.03em] tnum",
                      balanced ? "text-[#067647]" : "text-[#b54708]",
                    )}
                  >
                    {percent(total, 1)}
                  </p>
                  <p
                    className={cn(
                      "mt-1.5 text-[12px] leading-relaxed",
                      balanced ? "text-[#067647]" : "text-[#b54708]",
                    )}
                  >
                    {balanced
                      ? "Balanced. This mix will be accepted."
                      : Math.abs(delta) < 0.001
                        ? "Off by a fraction of a percent. Normalise to land on exactly 100% — the server accepts nothing else."
                        : `Off by ${delta > 0 ? "+" : "−"}${percent(Math.abs(delta), 1)} — the four weights must sum to exactly 100%.`}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Wand2 className="size-3.5" />}
                  disabled={balanced || total <= 0}
                  onClick={() => setDraft(normalise(current))}
                >
                  Normalise to 100%
                </Button>
              </div>

              {/* Presets */}
              <div className="mt-5 border-t border-[#e7eff3] pt-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                  Start from a preset
                </p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {PRESETS.map((preset) => {
                    const active = sameAs(current, preset.weights);
                    return (
                      <button
                        key={preset.name}
                        type="button"
                        title={preset.note}
                        onClick={() => {
                          setDraft(preset.weights);
                          setSaveError(null);
                        }}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-all duration-200",
                          active
                            ? "gradient-cta border-transparent text-white shadow-[0_6px_16px_rgba(46,96,120,0.26)]"
                            : "border-white/80 bg-white/60 text-[#5f7280] hover:bg-white/90 hover:text-[#243640]",
                        )}
                      >
                        {preset.name}
                        <span
                          className={cn(
                            "rounded-full px-1.5 text-[10.5px] tnum",
                            active ? "bg-white/25" : "bg-[#e7eff3] text-[#5f7280]",
                          )}
                        >
                          {CRITERIA.map((criterion) =>
                            Math.round(preset.weights[criterion] * 100),
                          ).join("/")}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11.5px] text-[#7e8c94]">
                  Each preset is price / delivery / warranty / reliability, as
                  percentages.
                </p>
              </div>
            </Panel>
          </div>

          {/* ------------------------------------------------------------
              Context
              ------------------------------------------------------------ */}
          <aside className="space-y-4">
            {isDefault ? (
              <Alert tone="brand" title="Currently on the environment fallbacks">
                <p>
                  No organisation row exists yet, so scoring is reading the
                  values configured as <Mono>SCORING_WEIGHT_PRICE</Mono>,{" "}
                  <Mono>SCORING_WEIGHT_DELIVERY</Mono>,{" "}
                  <Mono>SCORING_WEIGHT_WARRANTY</Mono> and{" "}
                  <Mono>SCORING_WEIGHT_RELIABILITY</Mono>.
                </p>
                <p className="mt-2 opacity-90">
                  Saving writes an organisation row that overrides them from the
                  next run onward. The environment values stay as the fallback.
                </p>
              </Alert>
            ) : (
              <Alert tone="positive" title="Organisation override in effect">
                <p>
                  These weights are stored against your organisation and take
                  precedence over the environment defaults.
                </p>
                {data?.org_id && (
                  <p className="mt-2 flex items-center gap-1.5">
                    <span className="opacity-90">Organisation</span>
                    <Mono>{data.org_id.slice(0, 8)}…</Mono>
                    <CopyButton value={data.org_id} label="Copy ID" />
                  </p>
                )}
              </Alert>
            )}

            <Panel
              className="animate-fade-up"
              icon={<Scale className="size-4" />}
              title="How a score is built"
              description="Every ranked quote shows this arithmetic in full."
            >
              <ol className="space-y-3">
                {[
                  "Each criterion is normalised to 0–1 across the offers actually returned — the comparison is relative to the table, never to an absolute benchmark.",
                  "Each normalised value is multiplied by its weight to give that criterion's contribution.",
                  "The contributions are summed. Because the weights sum to 1.0, a total score is directly readable as a percentage.",
                  "Where a value is missing, the component is imputed and marked, and the quote's data-confidence figure drops accordingly.",
                ].map((line, index) => (
                  <li key={index} className="flex gap-3">
                    <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-[#e9f3f8] text-[11px] font-bold text-[#38677b]">
                      {index + 1}
                    </span>
                    <p className="text-[12.5px] leading-relaxed text-[#5f7280]">
                      {line}
                    </p>
                  </li>
                ))}
              </ol>
            </Panel>

            <Panel
              className="animate-fade-up"
              icon={<Info className="size-4" />}
              title="When a change lands"
            >
              <p className="text-[12.5px] leading-relaxed text-[#5f7280]">
                On the next scored run. No redeploy, no restart — the engine
                reads the weights at the moment it ranks. Runs already recorded
                keep the mix they were decided under, which is what makes an old
                comparison still explainable.
              </p>
              {data?.label && (
                <div className="mt-3 rounded-[16px] bg-[#e9f3f8] px-3.5 py-2.5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                    Live mix
                  </p>
                  <p className="mt-1 text-[12.5px] font-semibold text-[#38677b] tnum">
                    {data.label}
                  </p>
                </div>
              )}
            </Panel>
          </aside>
        </div>
      )}
    </>
  );
}
