"use client";

/**
 * Agent internals.
 *
 * Every number on this page is read out of the running service — nothing here
 * is written down by the front end. `/health` reports the dependencies and the
 * scoring configuration the backend actually booted with, `/meta/workflow-types`
 * returns the compiled graph for each registered type, and `/meta/tools` returns
 * the tool registry. Together they turn the architecture claims into something
 * checkable rather than described.
 *
 * The workflow graphs are rendered from their real shape: `WorkflowTypeGraph`
 * mirrors `describe_graph()` field for field, so nodes are read as nodes and
 * edges as edges rather than as anonymous JSON. `health.database` is the one
 * genuinely loose payload — it is whatever the liveness probe happened to
 * return — so that reader, and only that reader, stays defensive.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Cloud,
  Coins,
  Database,
  GitBranch,
  Globe,
  Link2,
  Lock,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Workflow,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useMemo, type ReactNode } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  KeyValue,
  LiveDot,
  LoadingBlock,
  Mono,
  Panel,
  Skeleton,
  StatusPill,
  TONE_TEXT,
  cn,
} from "@/components/ui";
import { API_BASE_URL, API_V1, api } from "@/lib/api";
import {
  CRITERION_COLOR,
  CRITERION_LABEL,
  humanise,
  number,
  percent,
  relativeTime,
  type Tone,
} from "@/lib/format";
import { SUPABASE_URL } from "@/lib/supabase";
import type { GraphEdge, GraphNode, WorkflowTypeGraph } from "@/lib/types";

/* ==========================================================================
   Defensive readers — for `health.database` only, which is typed `unknown`
   because it is whatever `db.ping()` happened to return
   ========================================================================== */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Whatever a JSON value is, produce something printable for a table cell. */
function scalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim().length ? value : "—";
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

/* ==========================================================================
   Local presentation pieces
   ========================================================================== */

function Section({
  eyebrow,
  title,
  description,
  icon,
  actions,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  icon: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="animate-fade-up">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[12px] bg-white/70 text-[#447f98] shadow-[0_4px_12px_rgba(46,96,120,0.10)]">
            {icon}
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
              {eyebrow}
            </p>
            <h2 className="mt-0.5 text-[18px] font-bold leading-tight tracking-[-0.02em] text-[#243640]">
              {title}
            </h2>
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {description && (
        <p className="mb-4 max-w-3xl text-[13px] leading-relaxed text-[#5f7280]">
          {description}
        </p>
      )}
      {children}
    </section>
  );
}

function MetricTile({
  label,
  value,
  sub,
  tone = "neutral",
  icon,
  children,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  icon: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card variant="glass" padded={false} className="p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
          {label}
        </p>
        <span className={cn("shrink-0", TONE_TEXT[tone])} aria-hidden>
          {icon}
        </span>
      </div>
      <p
        className={cn(
          "mt-3 text-[22px] font-bold leading-none tracking-[-0.03em] break-words",
          tone === "neutral" ? "text-[#243640]" : TONE_TEXT[tone],
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-2 text-[12px] leading-relaxed text-[#7e8c94]">{sub}</p>}
      {children}
    </Card>
  );
}

/** A caption that explains why the thing above it is the way it is. */
function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 max-w-3xl text-[12.5px] leading-relaxed text-[#7e8c94]">
      {children}
    </p>
  );
}

function ConfigRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-[#243640]">{label}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[#7e8c94]">{hint}</p>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 sm:justify-end">
        <Mono className="min-w-0 break-all">{value}</Mono>
        <span className="shrink-0">
          <CopyButton value={value} label="Copy" />
        </span>
      </div>
    </div>
  );
}

/* ==========================================================================
   health.database — typed `unknown`, so treat it as unknown
   ========================================================================== */

interface DatabaseView {
  headline: string;
  tone: Tone;
  rows: { label: string; value: string }[];
}

function describeDatabase(value: unknown): DatabaseView {
  if (value === null || value === undefined) {
    return { headline: "Not reported", tone: "muted", rows: [] };
  }
  if (typeof value === "boolean") {
    return {
      headline: value ? "Connected" : "Unreachable",
      tone: value ? "positive" : "danger",
      rows: [],
    };
  }
  const record = asRecord(value);
  if (record) {
    const rows = Object.entries(record).map(([key, entry]) => ({
      label: humanise(key),
      value: scalar(entry),
    }));
    if (asBool(record.configured) === false) {
      return { headline: "Not configured", tone: "warning", rows };
    }
    const reachable = asBool(record.reachable);
    if (reachable !== null) {
      return {
        headline: reachable ? "Connected" : "Unreachable",
        tone: reachable ? "positive" : "danger",
        rows,
      };
    }
    return { headline: "Reported", tone: "neutral", rows };
  }
  return { headline: scalar(value), tone: "neutral", rows: [] };
}

/* ==========================================================================
   One compiled workflow graph — the typed shape describe_graph() returns
   ========================================================================== */

/** The template compiler writes the literal string "END" for a terminal edge. */
function isTerminal(target: string): boolean {
  const key = target.trim().toLowerCase();
  return key === "end" || key === "__end__";
}

/** Router outcomes are YAML keys, so "true" is a branch name, not prose. */
function branchLabel(outcome: string): string {
  if (outcome === "true") return "Yes";
  if (outcome === "false") return "No";
  return humanise(outcome);
}

/** A node reference inside the flow: its human title, with the graph key beside it. */
function NodeRef({
  name,
  title,
  gate,
}: {
  name: string;
  title?: string;
  gate?: boolean;
}) {
  if (isTerminal(name)) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full border border-[#e3ebef] bg-white/70 px-2.5 py-0.5 text-[11px] font-semibold text-[#7e8c94]">
        End of run
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-[12.5px] font-semibold text-[#243640]">
        {title ?? humanise(name)}
      </span>
      <Mono className="break-all">{name}</Mono>
      {gate && <Lock className="size-3 shrink-0 text-[#b54708]" aria-hidden />}
    </span>
  );
}

function GraphCard({ graph }: { graph: WorkflowTypeGraph }) {
  const nodes: GraphNode[] = graph.nodes ?? [];
  const edges: GraphEdge[] = graph.edges ?? [];
  const tools: string[] = graph.tools ?? [];

  // interrupt_nodes is the authority; the per-node flag says the same thing,
  // and agreeing with both costs nothing.
  const gates = new Set<string>(graph.interrupt_nodes ?? []);
  for (const node of nodes) {
    if (node.interrupt) gates.add(node.name);
  }

  const order = new Map<string, number>();
  const titleOf = new Map<string, string>();
  nodes.forEach((node, index) => {
    if (!order.has(node.name)) order.set(node.name, index);
    if (!titleOf.has(node.name)) titleOf.set(node.name, node.title);
  });

  /** A target declared earlier than its source is a loop — self-correction. */
  const loopsBack = (from: string, to: string) => {
    const fromIndex = order.get(from);
    const toIndex = order.get(to);
    return fromIndex !== undefined && toIndex !== undefined && toIndex < fromIndex;
  };

  // `to === null` is the whole signal: that edge is a conditional branch, and
  // every outcome it can take is mapped in `branches`.
  const plainEdges: { from: string; to: string }[] = edges.flatMap((edge) =>
    edge.to === null || edge.to === undefined
      ? []
      : [{ from: edge.from, to: edge.to }],
  );
  const branchEdges = edges.filter(
    (edge) => edge.to === null && Object.keys(edge.branches ?? {}).length > 0,
  );

  const description = graph.description?.trim();

  const stats: { label: string; value: number }[] = [
    { label: "Nodes", value: nodes.length },
    { label: "Edges", value: edges.length },
    { label: "Branches", value: branchEdges.length },
    { label: "Tools", value: tools.length },
    { label: "Human gates", value: gates.size },
    { label: "Self-correction", value: graph.max_self_correction_attempts },
  ];

  return (
    <Panel
      variant="glass"
      icon={<Workflow className="size-4" />}
      title={graph.title || humanise(graph.name)}
      description={description || undefined}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge tone="neutral">v{graph.version}</Badge>
          {graph.scoring_strategy && (
            <Badge tone="brand">{humanise(graph.scoring_strategy)}</Badge>
          )}
        </div>
      }
    >
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Mono className="break-all">{graph.name}</Mono>
        <span className="text-[12px] break-all text-[#7e8c94]">
          app/agent/templates/{graph.name}.yaml
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-[16px] bg-white/55 px-3.5 py-3">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
              {stat.label}
            </p>
            <p className="mt-1.5 text-[19px] font-bold leading-none tracking-[-0.02em] text-[#243640] tnum">
              {number(stat.value)}
            </p>
          </div>
        ))}
      </div>

      {/* Nodes are listed, not chained: template order is the order they are
          declared in, not a path. flag_for_human is only ever reached from a
          branch, so an arrow between the chips would be a lie. The path lives
          in the two edge sections below. */}
      {nodes.length > 0 && (
        <div className="mt-6">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            Nodes, in template order
          </p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {nodes.map((node, index) => {
              const gate = gates.has(node.name);
              return (
                <div
                  key={node.name}
                  className={cn(
                    "flex min-w-0 items-start gap-2.5 rounded-[16px] border px-3 py-2.5",
                    gate
                      ? "border-[#fedf89] bg-[#fffaeb]"
                      : "border-[#e7eff3] bg-white/60",
                  )}
                >
                  <span className="mt-0.5 text-[10.5px] font-semibold text-[#a9bac3] tnum">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={cn(
                          "text-[12.5px] font-semibold",
                          gate ? "text-[#b54708]" : "text-[#243640]",
                        )}
                      >
                        {node.title || humanise(node.name)}
                      </span>
                      {gate && <Lock className="size-3 text-[#b54708]" aria-hidden />}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Mono className="break-all">{node.name}</Mono>
                      {node.tool ? (
                        <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-[#5f7280]">
                          <Wrench className="size-3 shrink-0" aria-hidden />
                          <Mono className="break-all">{node.tool}</Mono>
                        </span>
                      ) : (
                        <span className="text-[11px] text-[#7e8c94]">No tool</span>
                      )}
                    </div>
                    {gate && (
                      <p className="mt-1 text-[11px] leading-relaxed text-[#b54708]">
                        The graph calls interrupt() here and waits for a person.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* The interesting half. A conditional edge has no `to`: it names its
          router in `conditional` and maps each outcome in `branches`. */}
      {branchEdges.length > 0 && (
        <div className="mt-6">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            Conditional branches
          </p>
          <div className="space-y-3">
            {branchEdges.map((edge) => (
              <div
                key={`${edge.from}-${edge.conditional ?? "branch"}`}
                className="rounded-[20px] border border-[#b9d8e1] bg-white/60 px-4 py-3.5"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
                  <GitBranch className="size-3.5 shrink-0 text-[#447f98]" aria-hidden />
                  <NodeRef
                    name={edge.from}
                    title={titleOf.get(edge.from)}
                    gate={gates.has(edge.from)}
                  />
                  <span className="text-[12px] text-[#5f7280]">routes on</span>
                  <Mono className="break-all">{edge.conditional ?? "—"}</Mono>
                </div>
                <ul className="mt-3 space-y-2">
                  {Object.entries(edge.branches ?? {}).map(([outcome, target]) => (
                    <li
                      key={outcome}
                      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5"
                    >
                      <span
                        title={`branch key: ${outcome}`}
                        className="shrink-0 rounded-full border border-[#d5e3ea] bg-white/80 px-2 py-0.5 text-[11px] font-semibold text-[#38677b]"
                      >
                        {branchLabel(outcome)}
                      </span>
                      <ArrowRight
                        className="size-3.5 shrink-0 text-[#b3c4cc]"
                        aria-hidden
                      />
                      <NodeRef
                        name={target}
                        title={titleOf.get(target)}
                        gate={gates.has(target)}
                      />
                      {loopsBack(edge.from, target) && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[#447f98]">
                          <RotateCcw className="size-3" aria-hidden />
                          <Badge tone="brand">Loops back</Badge>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {plainEdges.length > 0 && (
        <div className="mt-6">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            Direct edges
          </p>
          <div className="glass-flat overflow-x-auto rounded-[20px] px-4">
            <ul className="min-w-0 divide-y divide-[#eef4f7]">
              {plainEdges.map((edge) => (
                <li
                  key={`${edge.from}-${edge.to}`}
                  className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 py-2.5"
                >
                  <NodeRef
                    name={edge.from}
                    title={titleOf.get(edge.from)}
                    gate={gates.has(edge.from)}
                  />
                  <ArrowRight className="size-3.5 shrink-0 text-[#b3c4cc]" aria-hidden />
                  <NodeRef
                    name={edge.to}
                    title={titleOf.get(edge.to)}
                    gate={gates.has(edge.to)}
                  />
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {edges.length === 0 && (
        <p className="mt-6 text-[12.5px] leading-relaxed text-[#7e8c94]">
          This template declares no edges, so the engine would have nothing to
          walk after its entry node.
        </p>
      )}

      {tools.length > 0 && (
        <div className="mt-6">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
            Tools this type may call
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {tools.map((tool) => (
              <Mono key={tool} className="break-all">
                {tool}
              </Mono>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ==========================================================================
   Page
   ========================================================================== */

const WEIGHT_ORDER = ["price", "delivery", "warranty", "reliability"];

export default function SystemPage() {
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 15_000,
    retry: false,
  });

  const typesQuery = useQuery({
    queryKey: ["meta", "workflow-types"],
    queryFn: () => api.workflowTypes(),
  });

  const toolsQuery = useQuery({
    queryKey: ["meta", "tools"],
    queryFn: () => api.tools(),
  });

  const health = healthQuery.data;

  const weights = useMemo(() => {
    const raw = health?.scoring?.weights ?? {};
    const known = WEIGHT_ORDER.filter((key) => key in raw);
    const extra = Object.keys(raw).filter((key) => !WEIGHT_ORDER.includes(key));
    return [...known, ...extra].map((key) => ({
      key,
      weight: Number.isFinite(raw[key]) ? raw[key] : 0,
    }));
  }, [health]);

  const weightTotal = weights.reduce((sum, item) => sum + item.weight, 0);

  const database = describeDatabase(health?.database);

  const checkedAt = healthQuery.dataUpdatedAt
    ? new Date(healthQuery.dataUpdatedAt).toISOString()
    : null;

  const refreshing =
    healthQuery.isFetching || typesQuery.isFetching || toolsQuery.isFetching;

  const refreshAll = () => {
    void healthQuery.refetch();
    void typesQuery.refetch();
    void toolsQuery.refetch();
  };

  /* ---------------------------------------------------------------------
     /health needs no token, so a failure here is a reachability problem —
     say that, and show the URL the browser actually tried.
     --------------------------------------------------------------------- */
  const unreachable = (
    <Alert
      tone="danger"
      title="The console cannot reach the API"
      action={
        <Button size="sm" variant="secondary" onClick={() => void healthQuery.refetch()}>
          Retry
        </Button>
      }
    >
      <p>
        {healthQuery.error instanceof Error
          ? healthQuery.error.message
          : "The health endpoint did not answer."}
      </p>
      <p className="mt-2">
        The health endpoint needs no sign-in, so either the API is not running or{" "}
        <Mono className="break-all">NEXT_PUBLIC_API_BASE_URL</Mono> points
        somewhere else. This build is calling{" "}
        <Mono className="break-all">{API_BASE_URL}/health</Mono>.
      </p>
    </Alert>
  );

  return (
    <>
      <PageHeader
        title="Agent internals"
        description="A live read of the running backend: the dependencies it booted with, the scoring configuration in force, the workflow graphs it compiled from YAML, and the tools its nodes are allowed to call."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="glass-soft inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[11.5px] font-medium text-[#5f7280]">
              <LiveDot
                active={healthQuery.isFetching}
                tone={healthQuery.isError ? "danger" : "positive"}
              />
              {healthQuery.isError
                ? "Service unreachable"
                : checkedAt
                  ? `Checked ${relativeTime(checkedAt)}`
                  : "Checking…"}
            </span>
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw className="size-3.5" />}
              onClick={refreshAll}
              loading={refreshing}
            >
              Refresh
            </Button>
          </div>
        }
      />

      <div className="space-y-10 pb-4">
        {/* ================================================================
            01 — Service health
            ================================================================ */}
        <Section
          eyebrow="01 · Runtime"
          title="Service health"
          icon={<Activity className="size-4" />}
          description="Polled every fifteen seconds. An unconfigured dependency degrades one capability rather than taking the service down, so each row says what is missing and what stops working."
        >
          {healthQuery.isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-[124px] rounded-[28px]" />
              ))}
            </div>
          ) : healthQuery.isError ? (
            unreachable
          ) : health ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricTile
                  label="Status"
                  value={health.status === "ok" ? "Operational" : humanise(health.status)}
                  tone={health.status === "ok" ? "positive" : "warning"}
                  icon={<Activity className="size-4" />}
                  sub={
                    <>
                      Reported as <Mono>{health.status}</Mono>
                    </>
                  }
                />
                <MetricTile
                  label="Environment"
                  value={humanise(health.environment)}
                  icon={<Globe className="size-4" />}
                  sub="Set by ENVIRONMENT on the backend. Local relaxes CORS and enables /docs."
                />
                <MetricTile
                  label="Currency"
                  value={health.currency}
                  icon={<Coins className="size-4" />}
                  sub="Every amount in this console is formatted with the currency its own row carries; this is the default new work is created in."
                />
                <MetricTile
                  label="Database"
                  value={database.headline}
                  tone={database.tone}
                  icon={<Database className="size-4" />}
                  sub={database.rows.length === 0 ? "The probe returned no detail." : undefined}
                >
                  {database.rows.length > 0 && (
                    <dl className="mt-3 divide-y divide-[#eef4f7] border-t border-[#e7eff3]">
                      {database.rows.map((row) => (
                        <KeyValue
                          key={row.label}
                          label={row.label}
                          value={<span className="break-all">{row.value}</span>}
                        />
                      ))}
                    </dl>
                  )}
                </MetricTile>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <Panel
                  variant="glass"
                  icon={<Sparkles className="size-4" />}
                  title="Anthropic"
                  description="Plans the request, writes the selection justification."
                  actions={
                    <StatusPill
                      label={health.anthropic.configured ? "Configured" : "Not configured"}
                      tone={health.anthropic.configured ? "positive" : "warning"}
                    />
                  }
                >
                  <dl className="divide-y divide-[#eef4f7]">
                    <KeyValue
                      label="Model"
                      value={<Mono className="break-all">{health.anthropic.model}</Mono>}
                    />
                    <KeyValue
                      label="Workspace id"
                      value={
                        <StatusPill
                          size="sm"
                          dot={false}
                          label={health.anthropic.workspace_id_set ? "Set" : "Not set"}
                          tone={health.anthropic.workspace_id_set ? "positive" : "neutral"}
                        />
                      }
                    />
                  </dl>
                  <p className="mt-4 text-[12px] leading-relaxed text-[#7e8c94]">
                    The workspace flag is shown because it is not optional for every
                    key. An identity-linked key —{" "}
                    <Mono className="break-all">sk-ant-api03-…</Mono> — is rejected
                    with a 400 unless{" "}
                    <Mono className="break-all">ANTHROPIC_WORKSPACE_ID</Mono> names
                    the workspace it should act in. A classic workspace-scoped key
                    does not need it.
                  </p>
                  {!health.anthropic.configured && (
                    <Alert tone="warning" title="Planning will fail" className="mt-4">
                      <Mono className="break-all">ANTHROPIC_API_KEY</Mono> is not set
                      on the backend. Requests can still be listed and approvals
                      still resolve, but nothing new can be planned or justified.
                    </Alert>
                  )}
                </Panel>

                <Panel
                  variant="glass"
                  icon={<Cloud className="size-4" />}
                  title="Supabase"
                  description="Identity, and storage for generated purchase orders."
                  actions={
                    <StatusPill
                      label={health.supabase.configured ? "Configured" : "Not configured"}
                      tone={health.supabase.configured ? "positive" : "warning"}
                    />
                  }
                >
                  <dl className="divide-y divide-[#eef4f7]">
                    <KeyValue
                      label="Storage bucket"
                      value={<Mono className="break-all">{health.supabase.bucket}</Mono>}
                    />
                    <KeyValue
                      label="Token verification"
                      value={
                        <StatusPill
                          size="sm"
                          dot={false}
                          label={health.supabase.configured ? "Live" : "Unavailable"}
                          tone={health.supabase.configured ? "positive" : "warning"}
                        />
                      }
                    />
                  </dl>
                  <p className="mt-4 text-[12px] leading-relaxed text-[#7e8c94]">
                    Your session was issued by this project and verified by the API
                    against its JWKS. The service-role key stays on the backend — this
                    console only ever holds the publishable key.
                  </p>
                  {!health.supabase.configured && (
                    <Alert tone="warning" title="PDFs will not be stored" className="mt-4">
                      <Mono className="break-all">SUPABASE_URL</Mono> and{" "}
                      <Mono className="break-all">SUPABASE_SERVICE_ROLE_KEY</Mono>{" "}
                      are not both set. Purchase orders are still generated and
                      validated; only the uploaded PDF and its signed link are
                      missing.
                    </Alert>
                  )}
                </Panel>
              </div>
            </>
          ) : null}
        </Section>

        {/* ================================================================
            02 — Scoring configuration
            ================================================================ */}
        <Section
          eyebrow="02 · Decision policy"
          title="Scoring configuration"
          icon={<SlidersHorizontal className="size-4" />}
          description="How the agent ranks a shortlist, and how much rope it gives itself before it hands the problem to a person."
        >
          {healthQuery.isLoading ? (
            <LoadingBlock rows={2} />
          ) : healthQuery.isError ? (
            <Alert tone="danger" title="Scoring configuration unavailable">
              These values are read from the health endpoint, which is not
              answering. See Service health above.
            </Alert>
          ) : health ? (
            <>
              <Card variant="glass">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <p className="text-[13px] font-semibold text-[#243640]">
                    Criterion weights in force
                  </p>
                  <p className="text-[12px] text-[#7e8c94] tnum">
                    Total {percent(weightTotal)}
                  </p>
                </div>

                {weights.length === 0 ? (
                  <p className="mt-4 text-[12.5px] leading-relaxed text-[#7e8c94]">
                    The service reported no criterion weights at all, so nothing
                    would be ranked.
                  </p>
                ) : (
                  <>
                    {weightTotal > 0 ? (
                      <div className="mt-4 flex h-3.5 w-full overflow-hidden rounded-full bg-[#e7eff3]">
                        {weights
                          .filter((item) => item.weight > 0)
                          .map((item) => (
                            <span
                              key={item.key}
                              title={`${CRITERION_LABEL[item.key] ?? humanise(item.key)} · ${percent(item.weight)}`}
                              className="h-full transition-[width] duration-700 ease-out"
                              style={{
                                width: `${(item.weight / weightTotal) * 100}%`,
                                backgroundColor: CRITERION_COLOR[item.key] ?? "#b3c4cc",
                              }}
                            />
                          ))}
                      </div>
                    ) : (
                      <p className="mt-4 text-[12.5px] text-[#7e8c94]">
                        No criterion carries any weight, so nothing would be ranked.
                      </p>
                    )}

                    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {weights.map((item) => (
                        <div
                          key={item.key}
                          className="rounded-[16px] bg-white/55 px-4 py-3.5"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="size-2.5 shrink-0 rounded-full"
                              style={{
                                backgroundColor: CRITERION_COLOR[item.key] ?? "#b3c4cc",
                              }}
                              aria-hidden
                            />
                            <p className="truncate text-[12.5px] font-semibold text-[#243640]">
                              {CRITERION_LABEL[item.key] ?? humanise(item.key)}
                            </p>
                          </div>
                          <p className="mt-2 text-[24px] font-bold leading-none tracking-[-0.03em] text-[#243640] tnum">
                            {percent(item.weight)}
                          </p>
                          {item.weight === 0 && (
                            <p className="mt-1.5 text-[11.5px] text-[#7e8c94]">
                              Carried but not scored
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </Card>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <MetricTile
                  label="Self-correction budget"
                  value={number(health.scoring.self_correction_limit)}
                  icon={<RefreshCw className="size-4" />}
                  sub="How many times validate_po may send a draft back to generate_po. When the budget is spent the run escalates to a person instead of trying again."
                />
                <MetricTile
                  label="Tool retry limit"
                  value={number(health.scoring.tool_retry_limit)}
                  icon={<Wrench className="size-4" />}
                  sub="Attempts per tool call, with exponential backoff between them. Every attempt is written to tool_calls, whether it succeeded or not."
                />
              </div>

              <Alert
                tone="brand"
                title="These are the compiled defaults, not the last word"
                className="mt-4"
                action={
                  <Link
                    href="/admin/scoring"
                    className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-[12px] border border-[#b9d8e1] bg-white/70 px-3.5 text-[12.5px] font-semibold text-[#38677b] transition-colors duration-200 hover:bg-white"
                  >
                    Scoring weights
                    <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                }
              >
                The weights above are what the service booted with from its
                environment. A row in <Mono>scoring_weights</Mono> for an
                organisation overrides them at runtime — the next scored run picks
                the change up, with no redeploy and no restart.
              </Alert>
            </>
          ) : null}
        </Section>

        {/* ================================================================
            03 — Workflow types
            ================================================================ */}
        <Section
          eyebrow="03 · Generalizability"
          title="Registered workflow types"
          icon={<Workflow className="size-4" />}
          description="One record per compiled type, straight from describe_graph(). These are the graphs the engine will actually walk — not a diagram of them."
        >
          {typesQuery.isLoading ? (
            <LoadingBlock rows={2} />
          ) : typesQuery.error ? (
            <ErrorState error={typesQuery.error} onRetry={() => void typesQuery.refetch()} />
          ) : !typesQuery.data || typesQuery.data.length === 0 ? (
            <EmptyState
              icon={<Workflow className="size-6" />}
              title="No workflow types registered"
              description="The service compiled nothing from app/agent/templates/. Check that the YAML files shipped with this deployment."
            />
          ) : (
            <div className="space-y-4">
              {typesQuery.data.map((graph) => (
                <GraphCard key={graph.name} graph={graph} />
              ))}
            </div>
          )}

          <Note>
            Each type above is one YAML file in <Mono>app/agent/templates/</Mono>,
            compiled by the same engine.{" "}
            <Mono>reimbursement.yaml</Mono> is a different domain altogether — it
            checks an expense against policy rather than ranking vendors — and it
            reuses the same human gate, the same purchase-order tool and the same
            notification tool, with no change to the engine that runs it.
          </Note>
        </Section>

        {/* ================================================================
            04 — Tool registry
            ================================================================ */}
        <Section
          eyebrow="04 · Capabilities"
          title="Tool registry"
          icon={<Wrench className="size-4" />}
          description="What a node is permitted to reach for. A node without a tool is pure state manipulation; a node with one calls exactly this and nothing else."
        >
          {toolsQuery.isLoading ? (
            <div className="grid gap-4 lg:grid-cols-3">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-[150px] rounded-[28px]" />
              ))}
            </div>
          ) : toolsQuery.error ? (
            <ErrorState error={toolsQuery.error} onRetry={() => void toolsQuery.refetch()} />
          ) : !toolsQuery.data || toolsQuery.data.length === 0 ? (
            <EmptyState
              icon={<Wrench className="size-6" />}
              title="No tools registered"
              description="The registry is empty, so every node that declares a tool would fail on its first call."
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-3">
              {toolsQuery.data.map((tool) => {
                const extras = Object.entries(tool).filter(
                  ([entryKey]) => entryKey !== "name" && entryKey !== "description",
                );
                return (
                  <Card key={tool.name} variant="glass" className="flex flex-col">
                    <div className="flex items-start gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-white/70 text-[#447f98] shadow-[0_4px_12px_rgba(46,96,120,0.10)]">
                        <Wrench className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="font-mono text-[13px] font-semibold break-all text-[#243640]">
                          {tool.name}
                        </p>
                        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#5f7280]">
                          {asText(tool.description) ?? "No description registered."}
                        </p>
                      </div>
                    </div>
                    {extras.length > 0 && (
                      <dl className="mt-4 divide-y divide-[#eef4f7] border-t border-[#e7eff3]">
                        {extras.map(([entryKey, entryValue]) => (
                          <KeyValue
                            key={entryKey}
                            label={humanise(entryKey)}
                            value={
                              <span className="break-all">{scalar(entryValue)}</span>
                            }
                          />
                        ))}
                      </dl>
                    )}
                  </Card>
                );
              })}
            </div>
          )}

          <Note>
            Adding a tool is one file in <Mono>app/agent/tools/</Mono> plus one{" "}
            <Mono>register()</Mono> line — no change to the graph engine and no
            change to any node that does not want it. Every call goes through the
            same wrapper: retried with exponential backoff up to the limit above,
            and recorded either way, so a failure is as visible in the audit trail
            as a success.
          </Note>
        </Section>

        {/* ================================================================
            05 — Client configuration
            ================================================================ */}
        <Section
          eyebrow="05 · This build"
          title="Client configuration"
          icon={<Link2 className="size-4" />}
          description="Where this console is pointed. If a page cannot load, compare these against the deployment before looking anywhere else."
        >
          <Card variant="glass" padded={false} className="px-6 py-2">
            <div className="divide-y divide-[#eef4f7]">
              <ConfigRow
                label="API base URL"
                hint="From NEXT_PUBLIC_API_BASE_URL, baked in at build time."
                value={API_BASE_URL}
              />
              <ConfigRow
                label="Versioned API prefix"
                hint="Every call on this page but the health check goes through here."
                value={API_V1}
              />
              <ConfigRow
                label="Health endpoint"
                hint="Outside the versioned prefix, and open — no token required."
                value={`${API_BASE_URL}/health`}
              />
              <ConfigRow
                label="Supabase project"
                hint="From NEXT_PUBLIC_SUPABASE_URL. Issues your session; the backend verifies it against this project's JWKS."
                value={SUPABASE_URL}
              />
            </div>
          </Card>
        </Section>
      </div>
    </>
  );
}
