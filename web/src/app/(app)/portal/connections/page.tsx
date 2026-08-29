"use client";

/**
 * Catalog connections — vendor portal.
 *
 * A vendor can point AgentFlow at the system their prices already live in
 * instead of maintaining a second copy by hand. This screen registers those
 * sources and runs them on demand.
 *
 * Two things are stated plainly in the UI rather than hidden, because both
 * are true and both matter:
 *
 *  1. The connections are SIMULATED. No outbound HTTP leaves the server. The
 *     sync endpoint runs a seeded fake adapter behind the `CatalogSource`
 *     interface — the same interface the CSV importer and the manual editor
 *     use — so a real Shopify or WooCommerce adapter drops in later without
 *     touching this screen, the endpoint, or the agent.
 *  2. The agent never syncs anything. The vendor portal writes to the
 *     database on its own schedule and the agent only ever reads. That
 *     separation is what keeps a run fast, deterministic and replayable: a
 *     workflow can be re-run against the same snapshot and reach the same
 *     decision, which would be impossible if a node made live vendor calls.
 *
 * Credentials are write-only. The API stores a vault handle and returns only
 * whether one exists, so this page can show "Credentials stored" and can
 * never show the credential.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Globe,
  KeyRound,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Store,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/shell/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  DetailList,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Mono,
  Panel,
  Select,
  StatusPill,
  Switch,
  cn,
  useToast,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  dateTime,
  humanise,
  number as formatNumber,
  relativeTime,
  type Tone,
} from "@/lib/format";
import type {
  CatalogConnection,
  CatalogProvider,
  ConnectionStatus,
} from "@/lib/types";

/* ==========================================================================
   Local vocabulary — no *_LABEL map exists in format.ts for either of these
   enums, so they are defined once here.
   ========================================================================== */
interface ProviderStyle {
  label: string;
  blurb: string;
  icon: LucideIcon;
  chip: string;
  urlHint: string;
  keyHint: string;
}

const PROVIDERS: Record<CatalogProvider, ProviderStyle> = {
  shopify: {
    label: "Shopify",
    blurb: "Products and variants from a Shopify storefront.",
    icon: ShoppingBag,
    chip: "bg-[#ecfdf3] text-[#067647] border-[#a6f4c5]",
    urlHint: "https://your-store.myshopify.com",
    keyHint: "An Admin API access token.",
  },
  woocommerce: {
    label: "WooCommerce",
    blurb: "The products endpoint of a WooCommerce store.",
    icon: Store,
    chip: "bg-[#d6ebf3] text-[#38677b] border-[#b9d8e1]",
    urlHint: "https://your-store.com",
    keyHint: "A consumer key issued by WooCommerce.",
  },
  generic_rest: {
    label: "Generic REST",
    blurb: "Any endpoint that returns a list of items as JSON.",
    icon: Globe,
    chip: "bg-[#e7eff3] text-[#4a5c66] border-[#d5e3ea]",
    urlHint: "https://api.your-system.com/products",
    keyHint: "Sent as a bearer token by the adapter.",
  },
};

const PROVIDER_ORDER: CatalogProvider[] = ["shopify", "woocommerce", "generic_rest"];

const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: "Disconnected",
  connected: "Connected",
  error: "Error",
  syncing: "Syncing",
};

const CONNECTION_STATUS_TONE: Record<ConnectionStatus, Tone> = {
  disconnected: "muted",
  connected: "positive",
  error: "danger",
  syncing: "brand",
};

/* ==========================================================================
   The sync payload is adapter-shaped, so it is rendered generically rather
   than field by field. A future adapter that returns more keys shows them
   without this screen changing.

   Two of its keys are deliberately kept out of the value grid: `connection_id`
   is this card's own id and would put a bare UUID on screen, and `message` is
   a sentence rather than a value, so it reads in full underneath instead of
   being truncated inside a column.
   ========================================================================== */
const SYNC_HIDDEN_KEYS = new Set(["connection_id", "message"]);

const SYNC_KEY_LABEL: Record<string, string> = {
  status: "Result",
  items_fetched: "Items fetched",
  items_created: "Created",
  items_updated: "Updated",
  items_skipped: "Skipped",
  synced_at: "Synced",
  is_simulated: "Simulated adapter",
};

function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return typeof value === "string" && value in CONNECTION_STATUS_LABEL;
}

function renderScalar(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  // The adapter answers with the raw enum. It never reaches the screen as one.
  if (key === "status") {
    return isConnectionStatus(value)
      ? CONNECTION_STATUS_LABEL[value]
      : humanise(String(value));
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") {
    return key.endsWith("_at") ? dateTime(value) : value;
  }
  return JSON.stringify(value);
}

/** The sync endpoint answers 200 with `status: "error"` when the adapter threw. */
function syncFailed(payload: Record<string, unknown>): boolean {
  return payload.status === "error";
}

function syncMessage(payload: Record<string, unknown>): string | null {
  const message = payload.message;
  return typeof message === "string" && message.trim() !== "" ? message : null;
}

interface ConnectionForm {
  provider: CatalogProvider;
  label: string;
  store_url: string;
  api_key: string;
  auto_sync_enabled: boolean;
  sync_interval_minutes: string;
}

const EMPTY_FORM: ConnectionForm = {
  provider: "shopify",
  label: "",
  store_url: "",
  api_key: "",
  auto_sync_enabled: false,
  sync_interval_minutes: "60",
};

/* ==========================================================================
   Page
   ========================================================================== */
export default function VendorConnectionsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CatalogConnection | null>(null);
  const [syncResults, setSyncResults] = useState<Record<string, Record<string, unknown>>>(
    {},
  );

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["catalog", "connections"],
    queryFn: () => api.listConnections(),
  });

  const createMutation = useMutation({
    mutationFn: (input: ConnectionForm) =>
      api.createConnection({
        provider: input.provider,
        label: input.label.trim(),
        store_url: input.store_url.trim() || null,
        api_key: input.api_key.trim() || null,
        auto_sync_enabled: input.auto_sync_enabled,
        sync_interval_minutes: Number(input.sync_interval_minutes) || 60,
      }),
    onSuccess: (connection) => {
      queryClient.invalidateQueries({ queryKey: ["catalog", "connections"] });
      setCreating(false);
      setForm(EMPTY_FORM);
      setFormError(null);
      toast(
        connection.is_simulated
          ? `${PROVIDERS[connection.provider].label} registered. The adapter is simulated — no outbound call was made.`
          : `${PROVIDERS[connection.provider].label} connected.`,
      );
    },
    onError: (mutationError) => {
      setFormError(
        mutationError instanceof Error
          ? mutationError.message
          : "The connection could not be created.",
      );
    },
  });

  const syncMutation = useMutation({
    mutationFn: (id: string) => api.syncConnection(id),
    onSuccess: (payload, id) => {
      setSyncResults((current) => ({ ...current, [id]: payload }));
      queryClient.invalidateQueries({ queryKey: ["catalog", "connections"] });
      queryClient.invalidateQueries({ queryKey: ["catalog", "me"] });
      // A failed adapter still answers 200 — the failure is in the body. The
      // toast has to read the body or it would congratulate the vendor on a
      // sync that fetched nothing.
      const failed = syncFailed(payload);
      const message = syncMessage(payload);
      toast(
        failed
          ? (message ?? "The adapter reported an error. The detail is on the card.")
          : (message ?? "Sync finished. The result is on the card."),
        failed ? "danger" : "positive",
      );
    },
    onError: (syncError) => {
      toast(
        syncError instanceof Error ? syncError.message : "The sync failed.",
        "danger",
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: ["catalog", "connections"] });
      setSyncResults((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setPendingDelete(null);
      toast("Disconnected. Items it already synced stay in your catalog.");
    },
    onError: (deleteError) => {
      toast(
        deleteError instanceof Error ? deleteError.message : "Could not disconnect.",
        "danger",
      );
    },
  });

  const submit = () => {
    setFormError(null);
    if (!form.label.trim()) {
      setFormError("Give the connection a name — it is how you will tell two apart.");
      return;
    }
    // The API types this as an int above zero, so 0, 1.5 and "" are all 422s.
    // Catching them here keeps the message specific instead of generic.
    const interval = Number(form.sync_interval_minutes);
    if (!Number.isInteger(interval) || interval <= 0) {
      setFormError("The sync interval must be a whole number of minutes above zero.");
      return;
    }
    createMutation.mutate(form);
  };

  const forbidden = error instanceof ApiError && error.isForbidden;

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Connections"
        description="Point AgentFlow at the system your prices already live in, instead of keeping a second copy by hand."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            Connect a source
          </Button>
        }
      />

      <Alert
        tone="brand"
        className="mb-5"
        title="These connections are simulated"
        icon={<Plug className="size-4" />}
      >
        No outbound request leaves the server. Sync runs a seeded fake adapter
        behind the <Mono>CatalogSource</Mono> interface — the same interface the
        spreadsheet importer and the manual editor write through — so a real
        Shopify or WooCommerce adapter can drop in later without changing this
        screen, the endpoint, or a single line of agent code.
      </Alert>

      {isLoading ? (
        <LoadingBlock rows={3} />
      ) : forbidden ? (
        <Alert tone="warning" title="This is the vendor portal">
          Connections belong to a vendor&apos;s own catalog, so the endpoint is
          scoped to a vendor profile derived from your token. Sign in with a
          vendor account to use it.
        </Alert>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<Plug className="size-6" />}
          title="No sources connected"
          description="Connect a storefront or a REST endpoint and its products can be pulled into your catalog as drafts, ready to review and publish."
          action={
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Connect a source
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {data.map((connection) => {
            const provider = PROVIDERS[connection.provider];
            const ProviderIcon = provider.icon;
            const syncing =
              syncMutation.isPending && syncMutation.variables === connection.id;
            const outcome = syncResults[connection.id];

            return (
              <Card
                key={connection.id}
                variant="clay"
                padded={false}
                className="flex flex-col p-6"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "grid size-11 shrink-0 place-items-center rounded-[16px] border",
                      provider.chip,
                    )}
                  >
                    <ProviderIcon className="size-5" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-[15px] font-semibold tracking-[-0.01em] text-[#2e3e47]"
                      title={connection.label ?? provider.label}
                    >
                      {connection.label ?? provider.label}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone="neutral">{provider.label}</Badge>
                      <span className="text-[11.5px] text-[#7e8c94]">
                        added {relativeTime(connection.created_at)}
                      </span>
                    </div>
                  </div>
                  <StatusPill
                    tone={CONNECTION_STATUS_TONE[connection.status]}
                    label={CONNECTION_STATUS_LABEL[connection.status]}
                  />
                </div>

                <p className="clay-recess mt-4 truncate rounded-[14px] px-3 py-2 font-mono text-[11.5px] text-[#38677b]">
                  {connection.store_url ?? "No store URL set"}
                </p>

                <DetailList
                  className="mt-2"
                  items={[
                    {
                      label: "Automatic sync",
                      value: connection.auto_sync_enabled ? (
                        <span className="text-[#067647]">
                          On
                          {connection.sync_interval_minutes
                            ? ` · every ${formatNumber(connection.sync_interval_minutes)} min`
                            : ""}
                        </span>
                      ) : (
                        <span className="text-[#7e8c94]">Manual only</span>
                      ),
                    },
                    {
                      label: "Last sync",
                      value: connection.last_sync_at ? (
                        <span title={dateTime(connection.last_sync_at)}>
                          {relativeTime(connection.last_sync_at)}
                        </span>
                      ) : (
                        <span className="text-[#7e8c94]">Never</span>
                      ),
                    },
                    {
                      label: "Items last pulled",
                      value:
                        connection.last_sync_item_count === null ? (
                          <span className="text-[#7e8c94]">—</span>
                        ) : (
                          formatNumber(connection.last_sync_item_count)
                        ),
                    },
                    {
                      label: "Credentials",
                      value: connection.credentials_set ? (
                        <span className="inline-flex items-center gap-1.5 text-[#067647]">
                          <ShieldCheck className="size-3.5" />
                          Credentials stored
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[#7e8c94]">
                          <KeyRound className="size-3.5" />
                          No credentials
                        </span>
                      ),
                    },
                  ]}
                />

                <p className="mt-2 text-[11.5px] leading-relaxed text-[#7e8c94]">
                  Credentials are referenced by a vault handle. The API stores
                  only whether one exists and never returns the value, so nothing
                  on this page can reveal it.
                </p>

                {connection.last_error && (
                  <Alert
                    tone="danger"
                    className="mt-4"
                    title="Last sync reported an error"
                    icon={<AlertTriangle className="size-4" />}
                  >
                    <span className="break-words font-mono text-[11.5px]">
                      {connection.last_error}
                    </span>
                  </Alert>
                )}

                {outcome && (
                  <div className="clay-recess mt-4 rounded-[16px] px-3.5 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#7e8c94]">
                        Adapter response
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setSyncResults((current) => {
                            const next = { ...current };
                            delete next[connection.id];
                            return next;
                          })
                        }
                        className="text-[11px] font-semibold text-[#7e8c94] transition-colors hover:text-[#447f98]"
                      >
                        Hide
                      </button>
                    </div>
                    <dl className="mt-2 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                      {Object.entries(outcome)
                        .filter(([key]) => !SYNC_HIDDEN_KEYS.has(key))
                        .map(([key, value]) => (
                          <div
                            key={key}
                            className="flex items-baseline justify-between gap-3 border-b border-white/70 py-1.5"
                          >
                            <dt className="shrink-0 text-[11.5px] text-[#7e8c94]">
                              {SYNC_KEY_LABEL[key] ?? humanise(key)}
                            </dt>
                            <dd className="tnum min-w-0 truncate text-right text-[11.5px] font-semibold text-[#2e3e47]">
                              {renderScalar(key, value)}
                            </dd>
                          </div>
                        ))}
                    </dl>
                    {syncMessage(outcome) && (
                      <p
                        className={cn(
                          "mt-2.5 text-[11.5px] leading-relaxed",
                          syncFailed(outcome) ? "text-[#b42318]" : "text-[#5f7280]",
                        )}
                      >
                        {syncMessage(outcome)}
                      </p>
                    )}
                  </div>
                )}

                <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
                  <Button
                    size="sm"
                    loading={syncing}
                    icon={<RefreshCw className="size-3.5" />}
                    onClick={() => syncMutation.mutate(connection.id)}
                  >
                    {syncing ? "Syncing…" : "Sync now"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 className="size-3.5" />}
                    onClick={() => setPendingDelete(connection)}
                  >
                    Disconnect
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ---------------------------------------------------------------
          Why the agent never touches any of this.
          --------------------------------------------------------------- */}
      <Panel
        variant="clay"
        className="mt-6"
        icon={<ShieldCheck className="size-4" />}
        title="The agent never syncs — and that is deliberate"
        description="Where the write happens is the difference between a demo and a system you can audit."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="clay-recess rounded-[16px] p-4">
            <p className="text-[13px] font-semibold text-[#2e3e47]">
              You write, on your schedule
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[#5f7280]">
              Importing, editing and syncing all go through the same adapter and
              land in the database as drafts. Publishing is the separate act that
              makes them visible.
            </p>
          </div>
          <div className="clay-recess rounded-[16px] p-4">
            <p className="text-[13px] font-semibold text-[#2e3e47]">
              The agent only reads
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[#5f7280]">
              A run quotes against published items and records the snapshot it
              used. No workflow node makes a live vendor call, so a slow or
              broken storefront can never stall a run.
            </p>
          </div>
          <div className="clay-recess rounded-[16px] p-4">
            <p className="text-[13px] font-semibold text-[#2e3e47]">
              Which makes runs replayable
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[#5f7280]">
              The same request against the same snapshot reaches the same
              decision, with the same scoring maths, every time. That is what an
              approver is actually being asked to trust.
            </p>
          </div>
        </div>
      </Panel>

      {/* ---------------------------------------------------------------
          Connect a source
          --------------------------------------------------------------- */}
      <Modal
        open={creating}
        onClose={() => {
          setCreating(false);
          setFormError(null);
        }}
        title="Connect a source"
        description="Registered behind the CatalogSource adapter. Nothing is called until you press Sync now."
        width={560}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setCreating(false);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
            <Button loading={createMutation.isPending} onClick={submit}>
              Connect
            </Button>
          </>
        }
      >
        <div className="space-y-4 pb-2">
          <Field label="Provider" htmlFor="provider">
            <Select
              id="provider"
              value={form.provider}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  provider: event.target.value as CatalogProvider,
                }))
              }
            >
              {PROVIDER_ORDER.map((provider) => (
                <option key={provider} value={provider}>
                  {PROVIDERS[provider].label}
                </option>
              ))}
            </Select>
          </Field>
          <p className="-mt-2 text-[11.5px] leading-relaxed text-[#7e8c94]">
            {PROVIDERS[form.provider].blurb}
          </p>

          <Field
            label="Name"
            required
            htmlFor="label"
            hint="Shown on the card. Two connections to the same provider are told apart by this."
          >
            <Input
              id="label"
              value={form.label}
              placeholder="Main storefront"
              onChange={(event) =>
                setForm((current) => ({ ...current, label: event.target.value }))
              }
            />
          </Field>

          <Field label="Store URL" htmlFor="store_url" hint={PROVIDERS[form.provider].urlHint}>
            <Input
              id="store_url"
              value={form.store_url}
              placeholder={PROVIDERS[form.provider].urlHint}
              onChange={(event) =>
                setForm((current) => ({ ...current, store_url: event.target.value }))
              }
            />
          </Field>

          <Field
            label="API key"
            htmlFor="api_key"
            hint={`${PROVIDERS[form.provider].keyHint} Write-only: it is stored behind a vault handle and never returned by the API.`}
          >
            <Input
              id="api_key"
              type="password"
              autoComplete="off"
              value={form.api_key}
              placeholder="Optional for a simulated source"
              onChange={(event) =>
                setForm((current) => ({ ...current, api_key: event.target.value }))
              }
            />
          </Field>

          <div className="clay-recess rounded-[16px] px-3.5 py-3">
            <Switch
              checked={form.auto_sync_enabled}
              onChange={(next) =>
                setForm((current) => ({ ...current, auto_sync_enabled: next }))
              }
              label="Sync automatically"
            />
            <p className="mt-2 text-[11.5px] leading-relaxed text-[#5f7280]">
              Records how often this source should be pulled. Sync now works
              either way.
            </p>
            <div className="mt-3 max-w-[220px]">
              <Field label="Interval (minutes)" htmlFor="interval">
                <Input
                  id="interval"
                  type="number"
                  min={1}
                  className="tnum"
                  disabled={!form.auto_sync_enabled}
                  value={form.sync_interval_minutes}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      sync_interval_minutes: event.target.value,
                    }))
                  }
                />
              </Field>
            </div>
          </div>

          {formError && (
            <Alert tone="danger" title="That cannot be saved yet">
              {formError}
            </Alert>
          )}
        </div>
      </Modal>

      {/* ---------------------------------------------------------------
          Disconnect
          --------------------------------------------------------------- */}
      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Disconnect this source?"
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={deleteMutation.isPending}
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
            >
              Disconnect
            </Button>
          </>
        }
      >
        {pendingDelete && (
          <div className="space-y-3 pb-2">
            <p className="text-[13.5px] leading-relaxed text-[#2e3e47]">
              <span className="font-semibold">
                {pendingDelete.label ?? PROVIDERS[pendingDelete.provider].label}
              </span>{" "}
              will be removed, along with its stored credential handle.
            </p>
            <p className="text-[12.5px] leading-relaxed text-[#5f7280]">
              Items this source has already synced stay in your catalog — they are
              ordinary catalog rows now. You can reconnect at any time.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
