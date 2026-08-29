/**
 * The API contract, transcribed from the backend's Pydantic schemas.
 *
 * These mirror `backend/app/schemas/` and the hand-built dicts the routers
 * return. Where a router returns a hand-built dict rather than a response
 * model (most of them do, to keep the payload flat for the clients), the type
 * here follows the dict, not the schema — the dict is what actually ships.
 *
 * Enum string unions match `backend/app/schemas/enums.py` exactly. Those
 * values are also the Postgres CHECK constraints, so a value not listed here
 * cannot exist in the database.
 */

// ===========================================================================
// Enums
// ===========================================================================
export type UserRole = "employee" | "admin" | "vendor";

export type WorkflowType = "procurement" | "reimbursement";

export type WorkflowStatus =
  | "draft"
  | "running"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "completed"
  | "failed"
  | "escalated";

export type StepStatus =
  | "pending"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "skipped";

export type ToolCallStatus = "success" | "failed" | "retried" | "timeout";

export type VendorStatus = "pending" | "verified" | "suspended" | "flagged";

export type QuoteStatus =
  | "quoted"
  | "excluded_budget"
  | "excluded_coverage"
  | "excluded_stock"
  | "selected";

export type ValidationOutcome = "passed" | "failed" | "warning";

export type ApprovalDecision = "pending" | "approved" | "rejected";

export type PODeliveryStatus =
  | "issued"
  | "acknowledged"
  | "in_transit"
  | "delivered"
  | "cancelled";

export type ImportJobStatus =
  | "uploaded"
  | "previewed"
  | "committed"
  | "partially_committed"
  | "failed"
  | "cancelled";

export type CatalogProvider = "shopify" | "woocommerce" | "generic_rest";

export type ConnectionStatus = "disconnected" | "connected" | "error" | "syncing";

export type PolicyRuleType =
  | "max_amount"
  | "max_per_day"
  | "receipt_required"
  | "category_allowed"
  | "advance_notice_days";

export type WSEventType =
  | "workflow.status_changed"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "step.retrying"
  | "tool.called"
  | "comparison.ready"
  | "validation.result"
  | "selfcorrection.started"
  | "approval.required"
  | "workflow.completed"
  | "workflow.escalated"
  | "heartbeat";

// ===========================================================================
// Envelopes
// ===========================================================================
export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ErrorEnvelope {
  error: string;
  message: string;
  details?: { field?: string | null; message: string }[];
}

// ===========================================================================
// Planner
// ===========================================================================
/**
 * `budget` and `amount` are typed `number | string` on purpose.
 *
 * They live inside `workflows.entities_json`, a stored blob. Rows written
 * before the planner's serializer fix hold a Pydantic-rendered Decimal — the
 * string "10000000" — and those rows are still in the database. Pass them
 * through `money()` / `asNumber()` from @/lib/format, which coerce.
 */
export interface RequestItem {
  name: string;
  quantity: number;
  unit?: string | null;
  specification?: string | null;
  category_hint?: string | null;
  amount?: number | string | null;
  receipt?: boolean | null;
}

export interface PlannedStep {
  order: number;
  name: string;
  title: string;
  description: string;
  tool_name?: string | null;
}

export interface PlannerEntities {
  items: RequestItem[];
  /** May be a string on rows written before the serializer fix — see RequestItem. */
  budget?: number | string | null;
  currency: string;
  workflow_type: WorkflowType;
  approver?: string | null;
  notes?: string | null;
}

/** POST /workflows — screen 2a. Nothing has executed yet. */
export interface WorkflowPlanResponse {
  workflow_id: string;
  status: WorkflowStatus;
  summary: string;
  entities: PlannerEntities;
  plan: PlannedStep[];
  planner_attempts: number;
}

// ===========================================================================
// Workflows
// ===========================================================================
export interface WorkflowSummary {
  id: string;
  title: string;
  workflow_type: WorkflowType;
  status: WorkflowStatus;
  currency: string;
  total_amount: number | null;
  created_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  requester_id: string;
}

export interface ToolCallLite {
  id: string;
  tool_name: string;
  status: ToolCallStatus;
  attempt: number;
  retry_count: number;
  duration_ms: number | null;
  error: string | null;
}

export interface WorkflowStep {
  id: string;
  step_order: number;
  name: string;
  title: string;
  description: string | null;
  tool_name: string | null;
  status: StepStatus;
  retry_count: number;
  max_retries: number;
  duration_ms: number | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  tool_calls: ToolCallLite[];
}

/** GET /workflows/{id} — the REST equivalent of the live socket. */
export interface WorkflowDetail {
  id: string;
  title: string;
  request_text: string;
  workflow_type: WorkflowType;
  status: WorkflowStatus;
  currency: string;
  budget: number | null;
  total_amount: number | null;
  entities: PlannerEntities | null;
  plan: PlannedStep[] | null;
  summary: string | null;
  current_step_order: number | null;
  self_correction_attempts: number;
  escalation_reason: string | null;
  progress_percent: number;
  created_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  steps: WorkflowStep[];
}

export interface RunWorkflowResponse {
  workflow_id: string;
  status: WorkflowStatus;
  stream: string;
  poll: string;
}

// ===========================================================================
// Quotes and scoring — screens 5a / 11a
// ===========================================================================
export interface ScoreComponent {
  criterion: string;
  raw_value: number | null;
  normalised: number;
  weight: number;
  was_imputed: boolean;
  contribution: number;
}

export interface DataConfidence {
  percent: number;
  missing_fields: string[];
  scored_on: string[];
  label?: string;
}

export interface ScoreBreakdown {
  total: number;
  components: ScoreComponent[];
  confidence?: DataConfidence;
}

export interface QuoteLine {
  request_item_name: string;
  matched_title: string | null;
  sku: string | null;
  quantity: number;
  available: boolean;
  unit_price: number | null;
  line_total: number | null;
  delivery_days: number | null;
  warranty_months: number | null;
}

export interface Quote {
  id: string;
  vendor_id: string;
  vendor_name: string;
  status: QuoteStatus;
  exclusion_reason: string | null;
  total_amount: number | null;
  currency: string;
  delivery_days: number | null;
  warranty_months: number | null;
  items_covered: number;
  items_requested: number;
  score_total: number | null;
  score: ScoreBreakdown | null;
  confidence_percent: number | null;
  missing_fields: string[] | null;
  reliability_score: number | null;
  reliability_has_history: boolean;
  snapshot_taken_at: string;
  lines: QuoteLine[];
}

// ===========================================================================
// Validation — screens 6a / 6b
// ===========================================================================
/**
 * One row of `validation_reports.checks_json`.
 *
 * Stored as JSON rather than columns, so the shape is whatever the validator
 * wrote. The live payload uses `check` (not `check_type`) for the machine key
 * and `message` for the prose; `name`/`detail`/`check_type` are accepted too
 * because a stored report from an earlier validator version still has to render.
 */
export interface ValidationCheck {
  check?: string;
  check_type?: string;
  title?: string;
  name?: string;
  outcome?: ValidationOutcome;
  passed?: boolean;
  detail?: string | null;
  message?: string | null;
  expected?: string | number | null;
  actual?: string | number | null;
}

export interface ValidationReport {
  workflow_id: string;
  purchase_order_id: string | null;
  attempt: number;
  max_attempts: number;
  passed: boolean;
  checks: ValidationCheck[];
  validated_at: string;
}

// ===========================================================================
// Purchase orders — screen 7a
// ===========================================================================
export interface POLineItem {
  line_number: number;
  description: string;
  sku?: string | null;
  quantity: number;
  unit_price: number;
  line_total: number;
}

/**
 * The buyer's verdict on a delivered order.
 *
 * Deliberately distinct from `delivery_status`, which is the SUPPLIER's
 * account of the same order. A vendor marking something delivered and a buyer
 * confirming it arrived are different claims — and reliability scoring is only
 * defensible when it can tell them apart.
 */
export type POClosureOutcome =
  | "completed"
  | "completed_with_issues"
  | "cancelled";

export interface PurchaseOrder {
  id: string;
  po_number: string;
  workflow_id: string;
  vendor_id: string;
  quote_id: string;
  subtotal: number;
  tax: number;
  total_amount: number;
  currency: string;
  delivery_days: number | null;
  expected_delivery_date: string | null;
  warranty_months: number | null;
  payment_terms: string | null;
  delivery_status: PODeliveryStatus;
  generation_attempt: number;
  pdf_url: string | null;
  created_at: string;
  line_items: POLineItem[];
}

/** What `POST /workflows/{id}/purchase-order/close` gives back. */
export interface POCloseResult {
  id: string;
  po_number: string;
  closed_at: string;
  closed_by: string | null;
  closure_outcome: POClosureOutcome;
  closure_note: string | null;
  received_quantity: number | null;
  delivery_status: PODeliveryStatus;
}

// ===========================================================================
// Request for quotation
//
// The path out of the dead end. A workflow that escalated because nothing in
// the catalog matched — or nothing came in under budget — used to be finished.
// Now the buyer can ask, vendors answer, each answer is written into that
// vendor's catalog, and re-running the workflow picks the prices up through
// the ordinary catalog path. The agent is unchanged: it still only reads.
// ===========================================================================
export type QuoteRequestStatus = "open" | "closed" | "cancelled" | "expired";

export type QuoteResponseStatus = "invited" | "responded" | "declined";

export interface QuoteResponseLine {
  request_item_name: string;
  available: boolean;
  sku?: string | null;
  title?: string | null;
  unit_price?: number | null;
  quantity?: number | null;
  delivery_days?: number | null;
  warranty_months?: number | null;
  line_total?: number | null;
}

export interface QuoteResponse {
  id: string;
  vendor_id: string;
  vendor_name: string | null;
  status: QuoteResponseStatus;
  lines: QuoteResponseLine[];
  total_amount: number | null;
  currency: string | null;
  delivery_days: number | null;
  warranty_months: number | null;
  note: string | null;
  decline_reason: string | null;
  /** False means the reply exists but the agent cannot see it. */
  published_to_catalog: boolean;
  invited_at: string;
  responded_at: string | null;
}

export interface QuoteRequest {
  id: string;
  workflow_id: string;
  workflow_title: string | null;
  status: QuoteRequestStatus;
  /** Carried from the workflow's escalation reason. */
  reason: string | null;
  note: string | null;
  items: RequestItem[];
  currency: string;
  budget: number | null;
  closes_at: string | null;
  created_at: string;
  closed_at: string | null;
  responses: QuoteResponse[];
  invited_count: number;
  responded_count: number;
  /** "Asked 5 suppliers · 1 replied" — silence is information. */
  summary_line: string;
  /** True once at least one reply is live in the catalog and worth re-running. */
  is_actionable: boolean;
}

/**
 * The vendor's view. Carries only THIS vendor's row — a supplier never sees
 * what a competitor quoted, which is why responses are per-vendor rows.
 */
export interface VendorQuoteRequest {
  id: string;
  workflow_id: string;
  workflow_title: string | null;
  status: QuoteRequestStatus;
  reason: string | null;
  note: string | null;
  items: RequestItem[];
  currency: string;
  budget: number | null;
  closes_at: string | null;
  created_at: string;
  closed_at: string | null;
  my_response: QuoteResponse;
}

export interface QuoteResponseResult {
  response: QuoteResponse;
  catalog_items_published: number;
  detail: string;
}

// ===========================================================================
// Notifications — the bell
// ===========================================================================
export type NotificationKind =
  | "approval_required"
  | "approval_decided"
  | "po_issued"
  | "workflow_escalated"
  | "quote_requested"
  | "quote_received"
  | "po_closed";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  deep_link: string | null;
  workflow_id: string | null;
  /** The router emits both the boolean and the timestamp. */
  read: boolean;
  read_at: string | null;
  created_at: string;
}

export interface NotificationInbox {
  items: AppNotification[];
  unread_count: number;
  total: number;
}

/** The vendor-side shape from GET /vendors/me/purchase-orders. */
export interface VendorPurchaseOrder {
  id: string;
  po_number: string;
  total_amount: number;
  currency: string;
  delivery_status: PODeliveryStatus;
  expected_delivery_date: string | null;
  delivered_at: string | null;
  created_at: string;
  line_items: POLineItem[];
}

// ===========================================================================
// Completion report — screen 9a
// ===========================================================================
export interface ReportMetric {
  label: string;
  value: string;
  emphasis?: boolean;
}

export interface ReportSection {
  heading: string;
  body: string;
  bullets: string[];
}

export interface CompletionReport {
  workflow_id: string;
  title: string;
  headline: string;
  metrics: ReportMetric[];
  sections: ReportSection[];
  decisions: string[];
  caveats: string[];
  total_duration_ms: number | null;
  steps_executed: number;
  tools_invoked: number;
  retries_performed: number;
  generated_at: string;
}

// ===========================================================================
// Audit trail — screen 10b
// ===========================================================================
export interface AuditEvent {
  at: string;
  source: string;
  actor: string;
  event: string;
  detail: string | null;
  status: string | null;
  duration_ms: number | null;
  reference_id: string | null;
}

// ===========================================================================
// Approvals — screens 8a / 8b / 12a
// ===========================================================================
export interface ApprovalListItem {
  id: string;
  workflow_id: string;
  purchase_order_id: string | null;
  decision: ApprovalDecision;
  requested_at: string;
  title: string;
  budget: number | null;
  currency: string | null;
  total_amount: number | null;
  po_number: string | null;
}

export interface ApprovalDetail {
  id: string;
  workflow_id: string;
  decision: ApprovalDecision;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  comment: string | null;
  workflow: {
    title: string;
    request_text: string;
    budget: number | null;
    currency: string;
    status: WorkflowStatus;
  } | null;
  purchase_order: {
    id: string;
    po_number: string;
    total_amount: number;
    currency: string;
    delivery_days: number | null;
    warranty_months: number | null;
    line_items: POLineItem[];
  } | null;
}

export interface DecisionResponse {
  approval: {
    id: string;
    workflow_id: string;
    decision: ApprovalDecision;
    decided_at: string | null;
    decided_by: string | null;
    comment: string | null;
  };
  /** false on a double-tap — the graph resumes exactly once. */
  resumed: boolean;
}

// ===========================================================================
// Vendors — screens 13a / 18a
// ===========================================================================
export interface VendorReliability {
  has_history: boolean;
  orders_fulfilled: number;
  on_time_rate: number | null;
  quantity_accuracy: number | null;
  cancellations: number;
  late_deliveries: number;
  score: number | null;
  /** Ready to render: "4.8" or "No history yet". Never fabricated. */
  display: string;
}

export interface VendorFlag {
  reason: string;
  detail: string;
  threshold: string;
  raised_at: string;
  resolved_at?: string | null;
}

/**
 * Exactly what `_serialize` in `routers/vendors.py` returns — no more.
 *
 * The Pydantic `VendorRead` schema also declares `created_by`, `user_id` and
 * `catalog_item_count`, but the router builds its dict by hand and does not
 * emit them. Declaring them here would compile fine and render `undefined`,
 * so they are deliberately absent.
 */
export interface Vendor {
  id: string;
  name: string;
  legal_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  category: string | null;
  status: VendorStatus;
  verified_at: string | null;
  default_delivery_days: number | null;
  default_warranty_months: number | null;
  reliability: VendorReliability;
  flags: VendorFlag[];
  last_published_at: string | null;
  created_at: string;
}

export interface VendorCreate {
  name: string;
  legal_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  category?: string | null;
  default_delivery_days?: number | null;
  default_warranty_months?: number | null;
}

export interface FlaggedVendor {
  vendor_id: string;
  vendor_name: string;
  vendor_status: VendorStatus;
  reason: string;
  detail: string;
  threshold: string;
  raised_at: string;
}

// ===========================================================================
// Catalog — screens 14a / 14b / 14c / 15a
// ===========================================================================
export interface CatalogItem {
  id: string;
  vendor_id: string;
  vendor_name: string | null;
  sku: string;
  title: string;
  description: string | null;
  category: string | null;
  brand: string | null;
  price: number;
  sale_price: number | null;
  effective_price: number;
  currency: string;
  stock: number;
  is_low_stock: boolean;
  delivery_days: number | null;
  warranty_months: number | null;
  missing_terms: string[];
  visible: boolean;
  source: string;
  published_at: string | null;
  has_unpublished_changes: boolean;
  created_at: string;
}

export interface CatalogDraftState {
  vendor_id: string;
  unsaved_change_count: number;
  items_missing_terms: number;
  last_published_at: string | null;
  status_line: string;
}

export interface MyCatalogResponse extends Paged<CatalogItem> {
  draft_state: CatalogDraftState;
}

export interface CatalogItemCreate {
  sku: string;
  title: string;
  description?: string | null;
  category?: string | null;
  brand?: string | null;
  price: number;
  sale_price?: number | null;
  currency?: string;
  stock: number;
  delivery_days?: number | null;
  warranty_months?: number | null;
  visible?: boolean;
}

export type CatalogItemUpdate = Partial<Omit<CatalogItemCreate, "sku">>;

export interface PublishResult {
  published_count: number;
  published_at: string;
  skipped_missing_terms: string[];
}

export interface CatalogConnection {
  id: string;
  provider: CatalogProvider;
  label: string | null;
  store_url: string | null;
  status: ConnectionStatus;
  auto_sync_enabled: boolean;
  sync_interval_minutes: number | null;
  last_sync_at: string | null;
  last_sync_item_count: number | null;
  last_error: string | null;
  credentials_set: boolean;
  created_at: string;
}

// ===========================================================================
// CSV import — the vendor portal flow the Flutter app never built
// ===========================================================================
export interface ImportTargetField {
  name: string;
  required: boolean;
  example?: string | null;
  note?: string | null;
}

export interface ImportColumnMapping {
  source_column: string;
  target_field: string;
}

export interface ImportRowError {
  field?: string | null;
  message: string;
}

export interface ImportRowVerdict {
  row_number: number;
  raw: Record<string, unknown>;
  parsed: Record<string, unknown> | null;
  errors: ImportRowError[];
  is_duplicate_sku: boolean;
  missing_terms: string[];
  committed?: boolean;
}

export interface ImportPreview {
  import_job_id: string;
  filename: string;
  detected_columns: string[];
  suggested_mapping: ImportColumnMapping[];
  unmapped_columns: string[];
  target_fields: ImportTargetField[];
  rows: ImportRowVerdict[];
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  rows_missing_terms: number;
  truncated: boolean;
}

export interface ImportJob {
  id: string;
  vendor_id: string;
  filename: string;
  status: ImportJobStatus;
  total_rows: number;
  committed_rows: number;
  failed_rows: number;
  created_rows: number;
  updated_rows: number;
  rows_missing_terms: number;
  error: string | null;
  created_at: string;
  committed_at: string | null;
  summary_line: string;
}

export interface ImportCommitResult {
  job: ImportJob;
  failed_rows: ImportRowVerdict[];
  items_needing_terms: number[];
}

export interface ImportTemplate {
  filename: string;
  columns: ImportTargetField[];
  csv: string;
  max_rows: number;
  max_file_bytes: number;
}

// ===========================================================================
// Admin — screen 17a
// ===========================================================================
export interface DashboardStat {
  key: string;
  label: string;
  value: string;
  numeric_value: number;
  tone: "neutral" | "positive" | "warning" | "danger";
}

export interface AdminDashboard {
  stats: DashboardStat[];
  pending_approvals: number;
  active_workflows: number;
  completed_this_week: number;
  flagged_vendors: number;
  total_spend: number;
  currency: string;
  generated_at: string;
}

export interface SpendByVendor {
  vendor_id: string;
  vendor_name: string;
  order_count: number;
  total_spend: number;
  on_time_rate: number | null;
}

export interface SpendReport {
  currency: string;
  period_start: string;
  period_end: string;
  total_spend: number;
  order_count: number;
  by_vendor: SpendByVendor[];
  generated_at: string;
}

/**
 * The criterion weights the scorer uses.
 *
 * Note the field names: the API speaks `price` / `delivery` / `warranty` /
 * `reliability`, NOT the `SCORING_WEIGHT_*` env-var names. They must sum to
 * 1.0 — enforced by a Pydantic model validator AND a Postgres CHECK, so a
 * partial update cannot leave scoring in an invalid state.
 */
export interface ScoringWeights {
  price: number;
  delivery: number;
  warranty: number;
  reliability: number;
  /** "Price 50% · Delivery 30% · Warranty 20%" — computed server-side. */
  label?: string;
  /** True when falling back to the env-configured values, with no org row. */
  is_default?: boolean;
  org_id?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface PolicyRule {
  id: string;
  name: string;
  rule_type: PolicyRuleType;
  workflow_type: WorkflowType;
  category: string | null;
  numeric_value: number | null;
  currency: string | null;
  text_value: string | null;
  message: string | null;
  active: boolean;
  created_at: string;
}

// ===========================================================================
// Meta / introspection
// ===========================================================================
export interface HealthResponse {
  status: string;
  environment: string;
  currency: string;
  database: unknown;
  anthropic: { configured: boolean; model: string; workspace_id_set: boolean };
  supabase: { configured: boolean; bucket: string };
  tools: string[];
  workflow_types: string[];
  scoring: {
    weights: Record<string, number>;
    self_correction_limit: number;
    tool_retry_limit: number;
  };
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  [k: string]: unknown;
}

export interface GraphNode {
  name: string;
  title: string;
  handler: string;
  tool: string | null;
  /** route_approval is the human gate: the graph calls interrupt() here. */
  interrupt: boolean;
}

/**
 * One edge of the compiled graph.
 *
 * A plain edge has `to` set and `conditional` null. A branch has `to` null,
 * names its router in `conditional`, and maps each outcome in `branches` —
 * that is how `validate_po` reaches back to `generate_po` for self-correction
 * and forward to `flag_for_human` once the attempt budget is spent.
 */
export interface GraphEdge {
  from: string;
  to: string | null;
  conditional: string | null;
  branches: Record<string, string>;
}

/** `describe_graph()` — proves a workflow type is config, not code. */
export interface WorkflowTypeGraph {
  name: string;
  version: number;
  title: string;
  description: string;
  scoring_strategy: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  tools: string[];
  interrupt_nodes: string[];
  max_self_correction_attempts: number;
}

// ===========================================================================
// WebSocket frames
// ===========================================================================
export interface WSFrame<P = Record<string, unknown>> {
  type: WSEventType;
  workflow_id: string;
  seq: number;
  ts: string;
  payload: P;
}

export interface StepStartedPayload {
  step_id: string;
  step_order: number;
  name: string;
  title: string;
  tool_name?: string | null;
}

export interface StepCompletedPayload {
  step_id: string;
  step_order: number;
  name: string;
  duration_ms: number;
  output_summary?: string | null;
}

export interface StepFailedPayload {
  step_id: string;
  step_order: number;
  name: string;
  error: string;
  will_retry: boolean;
  retry_count: number;
  max_retries: number;
}

export interface StepRetryingPayload {
  step_id: string;
  step_order: number;
  name: string;
  attempt: number;
  max_attempts: number;
  delay_seconds: number;
  reason: string;
}

export interface ToolCalledPayload {
  tool_call_id: string;
  step_id: string;
  tool_name: string;
  status: string;
  duration_ms: number;
  retry_count: number;
  summary?: string | null;
}

export interface WorkflowStatusPayload {
  status: WorkflowStatus;
  previous_status?: WorkflowStatus | null;
  progress_percent: number;
}

export interface ComparisonReadyPayload {
  strategy: string;
  selected_vendor_name: string | null;
  justification: string;
  quote_count: number;
}

export interface ValidationResultPayload {
  passed: boolean;
  attempt: number;
  max_attempts: number;
  passed_count: number;
  total_checks: number;
  failed_check_titles: string[];
}

export interface SelfCorrectionPayload {
  attempt: number;
  max_attempts: number;
  reason: string;
}

export interface ApprovalRequiredPayload {
  approval_id: string;
  purchase_order_id: string | null;
  total_amount: number | null;
  currency: string;
  vendor_name: string | null;
}

export interface WorkflowCompletedPayload {
  status: WorkflowStatus;
  duration_ms: number | null;
  report_available: boolean;
}

export interface WorkflowEscalatedPayload {
  reason: string;
  stage: string;
  detail: string | null;
}
