/**
 * Typed HTTP client for the AgentFlow API.
 *
 * One function per backend endpoint, mirroring `app/lib/api/api_client.dart`
 * so the web console and the Flutter client speak to the same surface in the
 * same order. Pages never build a URL and never parse JSON — if the API
 * changes it changes here, and TypeScript finds every call site.
 *
 * Auth: the Supabase access token is attached per request by `getToken`,
 * which is installed once at startup by the auth provider. A 401 clears the
 * session, because the only useful response to an expired token is to sign in
 * again.
 */
import type {
  AdminDashboard,
  ApprovalDetail,
  ApprovalListItem,
  AuditEvent,
  CatalogConnection,
  CatalogItem,
  CatalogItemCreate,
  CatalogItemUpdate,
  CatalogProvider,
  CompletionReport,
  DecisionResponse,
  FlaggedVendor,
  HealthResponse,
  ImportColumnMapping,
  ImportCommitResult,
  ImportJob,
  ImportPreview,
  ImportTemplate,
  MyCatalogResponse,
  NotificationInbox,
  Paged,
  POCloseResult,
  POClosureOutcome,
  PODeliveryStatus,
  PolicyRule,
  PolicyRuleType,
  PublishResult,
  PurchaseOrder,
  Quote,
  QuoteRequest,
  QuoteResponse,
  QuoteResponseLine,
  QuoteResponseResult,
  RunWorkflowResponse,
  ScoringWeights,
  SpendReport,
  ToolDescriptor,
  ValidationReport,
  Vendor,
  VendorCreate,
  VendorPurchaseOrder,
  VendorQuoteRequest,
  VendorStatus,
  WorkflowDetail,
  WorkflowPlanResponse,
  WorkflowStatus,
  WorkflowSummary,
  WorkflowType,
  WorkflowTypeGraph,
} from "./types";

/* ==========================================================================
   Configuration
   ========================================================================== */

/** Where the backend lives. `run_local.py` serves it on :8000 by default. */
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000"
).replace(/\/+$/, "");

export const API_V1 = `${API_BASE_URL}/api/v1`;

/** ws:// for http://, wss:// for https:// — same rule as the Flutter client. */
export function wsUrl(
  workflowId: string,
  token: string,
  lastSeq = 0,
): string {
  const scheme = API_BASE_URL.startsWith("https") ? "wss" : "ws";
  const host = API_BASE_URL.replace(/^https?:\/\//, "");
  return `${scheme}://${host}/ws/workflows/${workflowId}?access_token=${encodeURIComponent(
    token,
  )}&last_seq=${lastSeq}`;
}

/* ==========================================================================
   Errors
   ========================================================================== */

/** A failure a page can render. Nothing above this layer sees a raw Response. */
export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly details: { field?: string | null; message: string }[];

  constructor(
    message: string,
    opts: {
      status?: number;
      code?: string;
      details?: { field?: string | null; message: string }[];
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details ?? [];
  }

  get isUnauthorised() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isNotFound() {
    return this.status === 404;
  }
  /** 503 + a machine code means a dependency is unconfigured, not a crash. */
  get isUnavailable() {
    return this.status === 503;
  }
}

/* ==========================================================================
   Token plumbing
   ========================================================================== */

type TokenProvider = () => Promise<string | null>;

let getToken: TokenProvider = async () => null;
let onUnauthorised: () => void = () => {};

export function configureApi(opts: {
  tokenProvider: TokenProvider;
  onUnauthorised?: () => void;
}) {
  getToken = opts.tokenProvider;
  if (opts.onUnauthorised) onUnauthorised = opts.onUnauthorised;
}

/* ==========================================================================
   Transport
   ========================================================================== */

type Query = Record<
  string,
  string | number | boolean | null | undefined
>;

function withQuery(path: string, query?: Query): string {
  if (!query) return `${API_V1}${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return `${API_V1}${path}${qs ? `?${qs}` : ""}`;
}

async function request<T>(
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown; form?: FormData } = {},
): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(withQuery(path, opts.query), {
      method,
      headers,
      body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      // Bearer tokens, not cookies — so `omit` keeps the wildcard CORS header
      // the backend sends (`CORS_ORIGINS=*`) valid for the browser.
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      "Cannot reach the server. Check that the API is running and that " +
        "NEXT_PUBLIC_API_BASE_URL points at it.",
    );
  }

  if (response.status === 401) onUnauthorised();

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const body = (data ?? {}) as Record<string, unknown>;
    // The backend's uniform envelope is {error, message, details}. FastAPI's
    // own HTTPException raises {detail} instead, so both are handled.
    const message =
      (typeof body.message === "string" && body.message) ||
      (typeof body.detail === "string" && body.detail) ||
      (Array.isArray(body.detail) && "Request validation failed.") ||
      `Request failed (${response.status})`;
    throw new ApiError(String(message), {
      status: response.status,
      code: typeof body.error === "string" ? body.error : undefined,
      details: Array.isArray(body.details)
        ? (body.details as { field?: string | null; message: string }[])
        : [],
    });
  }

  return data as T;
}

const get = <T,>(path: string, query?: Query) =>
  request<T>("GET", path, { query });
const post = <T,>(path: string, body?: unknown, query?: Query) =>
  request<T>("POST", path, { body: body ?? {}, query });
const patch = <T,>(path: string, body?: unknown) =>
  request<T>("PATCH", path, { body: body ?? {} });
const put = <T,>(path: string, body?: unknown) =>
  request<T>("PUT", path, { body: body ?? {} });
const del = <T,>(path: string) => request<T>("DELETE", path);

/* ==========================================================================
   Workflows — screens 2a, 3a, 4a, 5a, 6a, 7a, 9a, 10a, 10b
   ========================================================================== */

export const api = {
  /**
   * Screen 2a. Free text only — the planner infers the workflow type, and the
   * API deliberately refuses a client hint. Nothing executes until `runWorkflow`.
   */
  createWorkflow: (requestText: string, idempotencyKey?: string) =>
    post<WorkflowPlanResponse>("/workflows", {
      request_text: requestText,
      idempotency_key: idempotencyKey ?? null,
    }),

  /** Screen 3a → 4a. Returns immediately; watch progress on the socket. */
  runWorkflow: (id: string) =>
    post<RunWorkflowResponse>(`/workflows/${id}/run`),

  listWorkflows: (params: {
    status?: WorkflowStatus;
    workflow_type?: WorkflowType;
    search?: string;
    created_after?: string;
    created_before?: string;
    limit?: number;
    offset?: number;
  } = {}) => get<Paged<WorkflowSummary>>("/workflows", params),

  getWorkflow: (id: string) => get<WorkflowDetail>(`/workflows/${id}`),

  getComparison: async (id: string): Promise<Quote[]> => {
    const data = await get<{ quotes: Quote[] }>(`/workflows/${id}/comparison`);
    return data.quotes ?? [];
  },

  getValidation: (id: string) =>
    get<ValidationReport>(`/workflows/${id}/validation`),

  getPurchaseOrder: (id: string) =>
    get<PurchaseOrder>(`/workflows/${id}/purchase-order`),

  /**
   * The buyer's close-out. Not the same call as the vendor's
   * `updateDeliveryStatus` — that is the supplier's account of the order,
   * this is the buyer's, recorded against the signed-in user.
   * 409 when the order was already closed.
   */
  closePurchaseOrder: (
    workflowId: string,
    body: {
      outcome: POClosureOutcome;
      note?: string | null;
      received_quantity?: number | null;
    },
  ) =>
    post<POCloseResult>(`/workflows/${workflowId}/purchase-order/close`, body),

  getReport: (id: string) => get<CompletionReport>(`/workflows/${id}/report`),

  /* ------------------------------------------------------------------------
     Quote requests — the way out of an escalated workflow
     ---------------------------------------------------------------------- */

  /**
   * Ask vendors to quote. Omitting `vendor_ids` invites every verified vendor
   * in the org, which is the usual case: the buyer is asking precisely
   * because they do not know who can supply this.
   *
   * Idempotent by design — a workflow has at most one open request, and
   * asking twice returns the existing one rather than fragmenting the replies.
   */
  createQuoteRequest: (
    workflowId: string,
    body: {
      vendor_ids?: string[] | null;
      note?: string | null;
      respond_within_hours?: number;
    } = {},
  ) => post<QuoteRequest>(`/workflows/${workflowId}/quote-requests`, body),

  /** 404 when no request has been raised for this workflow. */
  getQuoteRequest: (workflowId: string) =>
    get<QuoteRequest>(`/workflows/${workflowId}/quote-requests`),

  closeQuoteRequest: (requestId: string) =>
    post<QuoteRequest>(`/quote-requests/${requestId}/close`),

  /* -- vendor side -------------------------------------------------------- */
  myQuoteRequests: async (
    includeClosed = false,
  ): Promise<VendorQuoteRequest[]> => {
    const data = await get<{ items: VendorQuoteRequest[] }>(
      "/quote-requests/me",
      { include_closed: includeClosed },
    );
    return data.items ?? [];
  },

  myOpenQuoteCount: () => get<{ open: number }>("/quote-requests/me/count"),

  /**
   * Answer a request. `publish_to_catalog` is the field that matters: the
   * agent reads the catalog and nothing else, so an unpublished reply cannot
   * be quoted against.
   */
  respondToQuoteRequest: (
    requestId: string,
    body: {
      lines: QuoteResponseLine[];
      note?: string | null;
      delivery_days?: number | null;
      warranty_months?: number | null;
      publish_to_catalog?: boolean;
    },
  ) => post<QuoteResponseResult>(`/quote-requests/${requestId}/respond`, body),

  /** "Cannot supply this" is a real answer, and better than silence. */
  declineQuoteRequest: (requestId: string, reason?: string) =>
    post<{ response: QuoteResponse }>(`/quote-requests/${requestId}/decline`, {
      reason: reason ?? null,
    }),

  /* ------------------------------------------------------------------------
     Notifications — the bell
     ---------------------------------------------------------------------- */
  notifications: (limit = 50, unreadOnly = false) =>
    get<NotificationInbox>("/me/notifications", {
      limit,
      unread_only: unreadOnly,
    }),

  /** One indexed count — the most-called route in the app. */
  unreadCount: () =>
    get<{ unread_count: number }>("/me/notifications/count"),

  markNotificationsRead: (ids?: string[]) =>
    post<{ marked: number; unread_count: number }>("/me/notifications/read", {
      notification_ids: ids ?? null,
    }),

  getAudit: (id: string) => get<AuditEvent[]>(`/workflows/${id}/audit`),

  /* ------------------------------------------------------------------------
     Approvals — the human gate. The agent never auto-approves.
     ---------------------------------------------------------------------- */
  listApprovals: (params: { limit?: number; offset?: number } = {}) =>
    get<Paged<ApprovalListItem>>("/approvals", params),

  getApproval: (id: string) => get<ApprovalDetail>(`/approvals/${id}`),

  /** Idempotent: a double-tap records once and resumes once. */
  decideApproval: (
    id: string,
    decision: "approved" | "rejected",
    comment?: string,
    idempotencyKey?: string,
  ) =>
    post<DecisionResponse>(`/approvals/${id}/decision`, {
      decision,
      comment: comment ?? null,
      idempotency_key: idempotencyKey ?? null,
    }),

  /* ------------------------------------------------------------------------
     Vendors
     ---------------------------------------------------------------------- */
  listVendors: (params: {
    status?: VendorStatus;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}) => get<Paged<Vendor>>("/vendors", params),

  getVendor: (id: string) => get<Vendor>(`/vendors/${id}`),

  /** Employee-submitted vendors land PENDING. Verification is an admin act. */
  createVendor: (body: VendorCreate) => post<Vendor>("/vendors", body),

  setVendorStatus: (id: string, status: VendorStatus, reason?: string) =>
    patch<Vendor>(`/vendors/${id}/status`, { status, reason: reason ?? null }),

  /** Refused once the vendor appears in a quote — suspend such a vendor instead. */
  deleteVendor: (id: string) =>
    del<{ deleted: boolean; id: string }>(`/vendors/${id}`),

  myPurchaseOrders: (params: {
    status?: PODeliveryStatus;
    limit?: number;
    offset?: number;
  } = {}) => get<Paged<VendorPurchaseOrder>>("/vendors/me/purchase-orders", params),

  updateDeliveryStatus: (
    poId: string,
    body: {
      delivery_status: PODeliveryStatus;
      quantity_delivered?: number | null;
      delivered_at?: string | null;
      note?: string | null;
    },
  ) =>
    patch<{
      id: string;
      po_number: string;
      delivery_status: PODeliveryStatus;
      delivered_at: string | null;
      quantity_delivered: number | null;
    }>(`/vendors/me/purchase-orders/${poId}/delivery`, body),

  /* ------------------------------------------------------------------------
     Catalog — vendor portal (14a/14b/14c) and buyer browse (15a)
     ---------------------------------------------------------------------- */
  myCatalog: (params: { limit?: number; offset?: number } = {}) =>
    get<MyCatalogResponse>("/catalog/me", params),

  createCatalogItem: (body: CatalogItemCreate) =>
    post<CatalogItem>("/catalog/me/items", body),

  updateCatalogItem: (itemId: string, body: CatalogItemUpdate) =>
    patch<CatalogItem>(`/catalog/me/items/${itemId}`, body),

  deleteCatalogItem: (itemId: string) =>
    del<{ deleted: boolean; id: string }>(`/catalog/me/items/${itemId}`),

  /** Publishing is what makes items visible to buyers and to the agent. */
  publishCatalog: (itemIds?: string[]) =>
    post<PublishResult>("/catalog/me/publish", { item_ids: itemIds ?? null }),

  browseCatalog: async (
    params: { vendor_id?: string; search?: string; limit?: number; offset?: number } = {},
  ): Promise<CatalogItem[]> => {
    const data = await get<{ items: CatalogItem[] }>("/catalog/browse", params);
    return data.items ?? [];
  },

  listConnections: () => get<CatalogConnection[]>("/catalog/me/connections"),

  createConnection: (body: {
    provider: CatalogProvider;
    label?: string | null;
    store_url?: string | null;
    api_key?: string | null;
    auto_sync_enabled?: boolean;
    sync_interval_minutes?: number | null;
  }) => post<CatalogConnection & { is_simulated: boolean }>("/catalog/me/connections", body),

  syncConnection: (id: string) =>
    post<Record<string, unknown>>(`/catalog/me/connections/${id}/sync`),

  deleteConnection: (id: string) =>
    del<{ deleted: boolean; id: string }>(`/catalog/me/connections/${id}`),

  /* ------------------------------------------------------------------------
     Spreadsheet import
     ---------------------------------------------------------------------- */
  importTemplate: () => get<ImportTemplate>("/imports/template"),

  previewImport: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<ImportPreview>("POST", "/imports/preview", { form });
  },

  commitImport: (
    jobId: string,
    body: {
      row_numbers?: number[] | null;
      mapping?: ImportColumnMapping[] | null;
      commit_valid_only?: boolean;
      update_existing_skus?: boolean;
    },
  ) => post<ImportCommitResult>(`/imports/${jobId}/commit`, body),

  listImports: async (): Promise<ImportJob[]> => {
    const data = await get<{ items: ImportJob[] }>("/imports");
    return data.items ?? [];
  },

  getImportJob: (jobId: string) =>
    get<{
      job: ImportJob;
      mapping: ImportColumnMapping[];
      rows: (ImportPreview["rows"][number] & { committed: boolean })[];
    }>(`/imports/${jobId}`),

  /* ------------------------------------------------------------------------
     Admin
     ---------------------------------------------------------------------- */
  getDashboard: () => get<AdminDashboard>("/admin/dashboard"),

  getSpendReport: (days = 30) => get<SpendReport>("/admin/spend", { days }),

  getScoringWeights: () => get<ScoringWeights>("/admin/scoring-weights"),

  /**
   * Takes effect on the next scored run — no redeploy.
   * The four values must sum to 1.0 or the API answers 422.
   */
  setScoringWeights: (weights: {
    price: number;
    delivery: number;
    warranty: number;
    reliability: number;
  }) => put<ScoringWeights>("/admin/scoring-weights", weights),

  listPolicyRules: (workflowType: WorkflowType = "reimbursement") =>
    get<PolicyRule[]>("/admin/policy-rules", { workflow_type: workflowType }),

  createPolicyRule: (body: {
    name: string;
    rule_type: PolicyRuleType;
    workflow_type: WorkflowType;
    category?: string | null;
    numeric_value?: number | null;
    currency?: string | null;
    text_value?: string | null;
    message?: string | null;
    active?: boolean;
  }) => post<{ id: string; name: string; active: boolean }>("/admin/policy-rules", body),

  deletePolicyRule: (id: string) =>
    del<{ deleted: boolean; id: string }>(`/admin/policy-rules/${id}`),

  flaggedVendors: () => get<FlaggedVendor[]>("/admin/flagged-vendors"),

  /* ------------------------------------------------------------------------
     Meta / introspection — proves "a workflow type is config, not code"
     ---------------------------------------------------------------------- */
  workflowTypes: () => get<WorkflowTypeGraph[]>("/meta/workflow-types"),

  tools: () => get<ToolDescriptor[]>("/meta/tools"),

  /** /health sits outside the versioned prefix. */
  health: async (): Promise<HealthResponse> => {
    const response = await fetch(`${API_BASE_URL}/health`, {
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) {
      throw new ApiError(`Health check failed (${response.status})`, {
        status: response.status,
      });
    }
    return (await response.json()) as HealthResponse;
  },
};

export type Api = typeof api;
