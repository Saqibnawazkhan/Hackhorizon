/// Typed models mirroring the backend Pydantic schemas.
///
/// Field names match the wire format exactly (snake_case), so there is no
/// translation layer to drift. Each model documents the backend schema it
/// mirrors; if one changes, both must.
///
/// Every `fromJson` is defensive about nulls: an in-flight workflow legitimately
/// has no purchase order, no validation report and no score, and the app must
/// render those states rather than crash on them.
library;

// ===========================================================================
// Enums -- mirror app/schemas/enums.py
// ===========================================================================
enum UserRole {
  employee,
  admin,
  vendor;

  static UserRole parse(String? v) => switch (v) {
        'admin' => UserRole.admin,
        'vendor' => UserRole.vendor,
        _ => UserRole.employee,
      };
}

enum WorkflowStatus {
  draft,
  running,
  awaitingApproval,
  approved,
  rejected,
  completed,
  failed,
  escalated;

  static WorkflowStatus parse(String? v) => switch (v) {
        'draft' => WorkflowStatus.draft,
        'running' => WorkflowStatus.running,
        'awaiting_approval' => WorkflowStatus.awaitingApproval,
        'approved' => WorkflowStatus.approved,
        'rejected' => WorkflowStatus.rejected,
        'completed' => WorkflowStatus.completed,
        'failed' => WorkflowStatus.failed,
        _ => WorkflowStatus.escalated,
      };

  /// The exact pill copy from the design.
  String get label => switch (this) {
        WorkflowStatus.draft => 'Draft',
        WorkflowStatus.running => 'In Progress',
        WorkflowStatus.awaitingApproval => 'Pending Approval',
        WorkflowStatus.approved => 'Approved',
        WorkflowStatus.rejected => 'Rejected',
        WorkflowStatus.completed => 'Done',
        WorkflowStatus.failed => 'Failed',
        WorkflowStatus.escalated => 'Needs Attention',
      };

  bool get isTerminal =>
      this == WorkflowStatus.completed ||
      this == WorkflowStatus.rejected ||
      this == WorkflowStatus.failed;
}

enum StepStatus {
  pending,
  running,
  retrying,
  completed,
  failed,
  skipped;

  static StepStatus parse(String? v) => switch (v) {
        'running' => StepStatus.running,
        'retrying' => StepStatus.retrying,
        'completed' => StepStatus.completed,
        'failed' => StepStatus.failed,
        'skipped' => StepStatus.skipped,
        _ => StepStatus.pending,
      };
}

enum QuoteStatus {
  quoted,
  excludedBudget,
  excludedCoverage,
  excludedStock,
  selected;

  static QuoteStatus parse(String? v) => switch (v) {
        'excluded_budget' => QuoteStatus.excludedBudget,
        'excluded_coverage' => QuoteStatus.excludedCoverage,
        'excluded_stock' => QuoteStatus.excludedStock,
        'selected' => QuoteStatus.selected,
        _ => QuoteStatus.quoted,
      };

  bool get isExcluded =>
      this == QuoteStatus.excludedBudget ||
      this == QuoteStatus.excludedCoverage ||
      this == QuoteStatus.excludedStock;
}

enum VendorStatus {
  pending,
  verified,
  suspended,
  flagged;

  static VendorStatus parse(String? v) => switch (v) {
        'verified' => VendorStatus.verified,
        'suspended' => VendorStatus.suspended,
        'flagged' => VendorStatus.flagged,
        _ => VendorStatus.pending,
      };

  String get label => switch (this) {
        VendorStatus.pending => 'Pending',
        VendorStatus.verified => 'Verified',
        VendorStatus.suspended => 'Suspended',
        VendorStatus.flagged => 'Flagged',
      };
}

enum ValidationOutcome {
  passed,
  failed,
  warning;

  static ValidationOutcome parse(String? v) => switch (v) {
        'failed' => ValidationOutcome.failed,
        'warning' => ValidationOutcome.warning,
        _ => ValidationOutcome.passed,
      };
}

enum PODeliveryStatus {
  issued,
  acknowledged,
  inTransit,
  delivered,
  cancelled;

  static PODeliveryStatus parse(String? v) => switch (v) {
        'acknowledged' => PODeliveryStatus.acknowledged,
        'in_transit' => PODeliveryStatus.inTransit,
        'delivered' => PODeliveryStatus.delivered,
        'cancelled' => PODeliveryStatus.cancelled,
        _ => PODeliveryStatus.issued,
      };

  String get wire => switch (this) {
        PODeliveryStatus.acknowledged => 'acknowledged',
        PODeliveryStatus.inTransit => 'in_transit',
        PODeliveryStatus.delivered => 'delivered',
        PODeliveryStatus.cancelled => 'cancelled',
        PODeliveryStatus.issued => 'issued',
      };

  String get label => switch (this) {
        PODeliveryStatus.issued => 'Issued',
        PODeliveryStatus.acknowledged => 'Acknowledged',
        PODeliveryStatus.inTransit => 'In Transit',
        PODeliveryStatus.delivered => 'Delivered',
        PODeliveryStatus.cancelled => 'Cancelled',
      };
}

// ===========================================================================
// Helpers
// ===========================================================================
/// Tolerant numeric parsing.
///
/// A client should not crash because a server rendered a Decimal as a string.
/// The backend has been fixed to emit numbers, but rows written before that
/// fix still carry strings in `entities_json`, and being lenient here costs
/// nothing while a hard cast costs a crash on a real user's screen.
double? _d(dynamic v) => switch (v) {
      null => null,
      final num n => n.toDouble(),
      final String s => double.tryParse(s),
      _ => null,
    };

int? _i(dynamic v) => switch (v) {
      null => null,
      final num n => n.toInt(),
      final String s => int.tryParse(s) ?? double.tryParse(s)?.toInt(),
      _ => null,
    };
DateTime? _t(dynamic v) =>
    v == null ? null : DateTime.tryParse(v as String)?.toLocal();
List<String> _s(dynamic v) =>
    (v as List?)?.map((e) => e.toString()).toList() ?? const [];

// ===========================================================================
// Auth
// ===========================================================================
class AppUser {
  const AppUser({
    required this.id,
    required this.email,
    required this.role,
    this.fullName,
    this.orgId,
    this.vendorId,
    this.avatarInitials,
  });

  final String id;
  final String email;
  final UserRole role;
  final String? fullName;
  final String? orgId;
  final String? vendorId;
  final String? avatarInitials;

  /// "SA" for Sara Ahmed -- the design shows initials in the avatar circle.
  String get initials {
    if (avatarInitials != null && avatarInitials!.isNotEmpty) {
      return avatarInitials!;
    }
    final parts = (fullName ?? email).trim().split(RegExp(r'\s+'));
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return (fullName ?? email).substring(0, 2).toUpperCase();
  }

  String get displayName => fullName ?? email.split('@').first;

  factory AppUser.fromJson(Map<String, dynamic> j) => AppUser(
        id: j['id'] as String,
        email: (j['email'] ?? '') as String,
        role: UserRole.parse(j['role'] as String?),
        fullName: j['full_name'] as String?,
        orgId: j['org_id'] as String?,
        vendorId: j['vendor_id'] as String?,
        avatarInitials: j['avatar_initials'] as String?,
      );
}

// ===========================================================================
// Planner -- screens 2a / 3a
// ===========================================================================
class RequestItem {
  const RequestItem({
    required this.name,
    required this.quantity,
    this.unit,
    this.specification,
  });

  final String name;
  final int quantity;
  final String? unit;
  final String? specification;

  /// "Laptops × 50" -- the entity chip on screens 2a and 11a.
  String get chipLabel => '${_titleCase(name)} × $quantity';

  factory RequestItem.fromJson(Map<String, dynamic> j) => RequestItem(
        name: j['name'] as String,
        quantity: (j['quantity'] as num).toInt(),
        unit: j['unit'] as String?,
        specification: j['specification'] as String?,
      );
}

class PlannedStep {
  const PlannedStep({
    required this.order,
    required this.name,
    required this.title,
    required this.description,
    this.toolName,
  });

  final int order;
  final String name;
  final String title;
  final String description;
  final String? toolName;

  factory PlannedStep.fromJson(Map<String, dynamic> j) => PlannedStep(
        order: (j['order'] as num).toInt(),
        name: j['name'] as String,
        title: j['title'] as String,
        description: (j['description'] ?? '') as String,
        toolName: j['tool_name'] as String?,
      );
}

class PlannerEntities {
  const PlannerEntities({
    required this.items,
    required this.currency,
    required this.workflowType,
    this.budget,
    this.approver,
  });

  final List<RequestItem> items;
  final String currency;
  final String workflowType;
  final double? budget;
  final String? approver;

  bool get isMultiItem => items.length > 1;
  int get totalQuantity => items.fold(0, (s, i) => s + i.quantity);

  factory PlannerEntities.fromJson(Map<String, dynamic> j) => PlannerEntities(
        items: ((j['items'] as List?) ?? const [])
            .map((e) => RequestItem.fromJson(e as Map<String, dynamic>))
            .toList(),
        currency: (j['currency'] ?? 'PKR') as String,
        workflowType: (j['workflow_type'] ?? 'procurement') as String,
        budget: _d(j['budget']),
        approver: j['approver'] as String?,
      );
}

class WorkflowPlan {
  const WorkflowPlan({
    required this.workflowId,
    required this.status,
    required this.summary,
    required this.entities,
    required this.plan,
    required this.plannerAttempts,
  });

  final String workflowId;
  final WorkflowStatus status;
  final String summary;
  final PlannerEntities entities;
  final List<PlannedStep> plan;
  final int plannerAttempts;

  /// True when the planner had to repair its own malformed output. Surfaced
  /// in the audit trail rather than hidden.
  bool get selfCorrected => plannerAttempts > 1;

  factory WorkflowPlan.fromJson(Map<String, dynamic> j) => WorkflowPlan(
        workflowId: j['workflow_id'] as String,
        status: WorkflowStatus.parse(j['status'] as String?),
        summary: (j['summary'] ?? '') as String,
        entities:
            PlannerEntities.fromJson(j['entities'] as Map<String, dynamic>),
        plan: ((j['plan'] as List?) ?? const [])
            .map((e) => PlannedStep.fromJson(e as Map<String, dynamic>))
            .toList(),
        plannerAttempts: _i(j['planner_attempts']) ?? 1,
      );
}

// ===========================================================================
// Execution -- screens 4a / 4b
// ===========================================================================
class ToolCall {
  const ToolCall({
    required this.id,
    required this.toolName,
    required this.status,
    required this.attempt,
    required this.retryCount,
    required this.durationMs,
    this.error,
  });

  final String id;
  final String toolName;
  final String status;
  final int attempt;
  final int retryCount;
  final int durationMs;
  final String? error;

  /// "catalog_query · 412ms · success" -- the expanded tool log on 4a.
  String get logLine => '$toolName · ${durationMs}ms · $status';

  factory ToolCall.fromJson(Map<String, dynamic> j) => ToolCall(
        id: j['id'] as String,
        toolName: j['tool_name'] as String,
        status: (j['status'] ?? '') as String,
        attempt: _i(j['attempt']) ?? 1,
        retryCount: _i(j['retry_count']) ?? 0,
        durationMs: _i(j['duration_ms']) ?? 0,
        error: j['error'] as String?,
      );
}

class WorkflowStep {
  const WorkflowStep({
    required this.id,
    required this.order,
    required this.name,
    required this.title,
    required this.status,
    required this.retryCount,
    required this.maxRetries,
    required this.toolCalls,
    this.description,
    this.toolName,
    this.durationMs,
    this.error,
    this.startedAt,
    this.completedAt,
  });

  final String id;
  final int order;
  final String name;
  final String title;
  final StepStatus status;
  final int retryCount;
  final int maxRetries;
  final List<ToolCall> toolCalls;
  final String? description;
  final String? toolName;
  final int? durationMs;
  final String? error;
  final DateTime? startedAt;
  final DateTime? completedAt;

  bool get isRetrying => status == StepStatus.retrying;
  bool get isActive =>
      status == StepStatus.running || status == StepStatus.retrying;

  factory WorkflowStep.fromJson(Map<String, dynamic> j) => WorkflowStep(
        id: j['id'] as String,
        order: (j['step_order'] as num).toInt(),
        name: j['name'] as String,
        title: j['title'] as String,
        status: StepStatus.parse(j['status'] as String?),
        retryCount: _i(j['retry_count']) ?? 0,
        maxRetries: _i(j['max_retries']) ?? 3,
        toolCalls: ((j['tool_calls'] as List?) ?? const [])
            .map((e) => ToolCall.fromJson(e as Map<String, dynamic>))
            .toList(),
        description: j['description'] as String?,
        toolName: j['tool_name'] as String?,
        durationMs: _i(j['duration_ms']),
        error: j['error'] as String?,
        startedAt: _t(j['started_at']),
        completedAt: _t(j['completed_at']),
      );
}

class WorkflowSummary {
  const WorkflowSummary({
    required this.id,
    required this.title,
    required this.workflowType,
    required this.status,
    required this.currency,
    required this.createdAt,
    this.totalAmount,
    this.completedAt,
    this.durationMs,
  });

  final String id;
  final String title;
  final String workflowType;
  final WorkflowStatus status;
  final String currency;
  final DateTime createdAt;
  final double? totalAmount;
  final DateTime? completedAt;
  final int? durationMs;

  /// "Procurement · 2m ago" -- the list-tile subtitle on screens 1a / 10a.
  String get subtitle => '${_titleCase(workflowType)} · ${_ago(createdAt)}';

  factory WorkflowSummary.fromJson(Map<String, dynamic> j) => WorkflowSummary(
        id: j['id'] as String,
        title: (j['title'] ?? '') as String,
        workflowType: (j['workflow_type'] ?? '') as String,
        status: WorkflowStatus.parse(j['status'] as String?),
        currency: (j['currency'] ?? 'PKR') as String,
        createdAt: _t(j['created_at']) ?? DateTime.now(),
        totalAmount: _d(j['total_amount']),
        completedAt: _t(j['completed_at']),
        durationMs: _i(j['duration_ms']),
      );
}

class WorkflowDetail {
  const WorkflowDetail({
    required this.id,
    required this.title,
    required this.requestText,
    required this.workflowType,
    required this.status,
    required this.currency,
    required this.steps,
    required this.progressPercent,
    required this.createdAt,
    this.budget,
    this.totalAmount,
    this.entities,
    this.summary,
    this.escalationReason,
    this.selfCorrectionAttempts = 0,
    this.durationMs,
    this.completedAt,
  });

  final String id;
  final String title;
  final String requestText;
  final String workflowType;
  final WorkflowStatus status;
  final String currency;
  final List<WorkflowStep> steps;
  final int progressPercent;
  final DateTime createdAt;
  final double? budget;
  final double? totalAmount;
  final PlannerEntities? entities;
  final String? summary;
  final String? escalationReason;
  final int selfCorrectionAttempts;
  final int? durationMs;
  final DateTime? completedAt;

  WorkflowStep? get activeStep =>
      steps.where((s) => s.isActive).firstOrNull ??
      steps.where((s) => s.status == StepStatus.failed).firstOrNull;

  factory WorkflowDetail.fromJson(Map<String, dynamic> j) => WorkflowDetail(
        id: j['id'] as String,
        title: (j['title'] ?? '') as String,
        requestText: (j['request_text'] ?? '') as String,
        workflowType: (j['workflow_type'] ?? '') as String,
        status: WorkflowStatus.parse(j['status'] as String?),
        currency: (j['currency'] ?? 'PKR') as String,
        steps: ((j['steps'] as List?) ?? const [])
            .map((e) => WorkflowStep.fromJson(e as Map<String, dynamic>))
            .toList(),
        progressPercent: _i(j['progress_percent']) ?? 0,
        createdAt: _t(j['created_at']) ?? DateTime.now(),
        budget: _d(j['budget']),
        totalAmount: _d(j['total_amount']),
        entities: j['entities'] == null
            ? null
            : PlannerEntities.fromJson(j['entities'] as Map<String, dynamic>),
        summary: j['summary'] as String?,
        escalationReason: j['escalation_reason'] as String?,
        selfCorrectionAttempts: _i(j['self_correction_attempts']) ?? 0,
        durationMs: _i(j['duration_ms']),
        completedAt: _t(j['completed_at']),
      );
}

// ===========================================================================
// Comparison -- screens 5a / 11a
// ===========================================================================
class ScoreComponent {
  const ScoreComponent({
    required this.criterion,
    required this.normalised,
    required this.weight,
    required this.contribution,
    required this.wasImputed,
  });

  final String criterion;
  final double normalised;
  final double weight;

  /// Points out of 100 -- the segment width in the design's stacked bar.
  final double contribution;

  /// True when the vendor omitted this field and a neutral value was used.
  final bool wasImputed;

  factory ScoreComponent.fromJson(Map<String, dynamic> j) => ScoreComponent(
        criterion: j['criterion'] as String,
        normalised: _d(j['normalised']) ?? 0,
        weight: _d(j['weight']) ?? 0,
        contribution: _d(j['contribution']) ?? 0,
        wasImputed: (j['was_imputed'] ?? false) as bool,
      );
}

class QuoteLine {
  const QuoteLine({
    required this.requestItemName,
    required this.quantity,
    required this.available,
    this.matchedTitle,
    this.sku,
    this.unitPrice,
    this.lineTotal,
    this.deliveryDays,
    this.warrantyMonths,
  });

  final String requestItemName;
  final int quantity;
  final bool available;
  final String? matchedTitle;
  final String? sku;
  final double? unitPrice;
  final double? lineTotal;
  final int? deliveryDays;
  final int? warrantyMonths;

  factory QuoteLine.fromJson(Map<String, dynamic> j) => QuoteLine(
        requestItemName: j['request_item_name'] as String,
        quantity: (j['quantity'] as num).toInt(),
        available: (j['available'] ?? false) as bool,
        matchedTitle: j['matched_title'] as String?,
        sku: j['sku'] as String?,
        unitPrice: _d(j['unit_price']),
        lineTotal: _d(j['line_total']),
        deliveryDays: _i(j['delivery_days']),
        warrantyMonths: _i(j['warranty_months']),
      );
}

class Quote {
  const Quote({
    required this.id,
    required this.vendorId,
    required this.vendorName,
    required this.status,
    required this.currency,
    required this.itemsCovered,
    required this.itemsRequested,
    required this.lines,
    required this.components,
    this.totalAmount,
    this.deliveryDays,
    this.warrantyMonths,
    this.scoreTotal,
    this.confidencePercent,
    this.missingFields = const [],
    this.reliabilityScore,
    this.reliabilityHasHistory = false,
    this.exclusionReason,
  });

  final String id;
  final String vendorId;
  final String vendorName;
  final QuoteStatus status;
  final String currency;
  final int itemsCovered;
  final int itemsRequested;
  final List<QuoteLine> lines;
  final List<ScoreComponent> components;
  final double? totalAmount;
  final int? deliveryDays;
  final int? warrantyMonths;
  final double? scoreTotal;
  final int? confidencePercent;
  final List<String> missingFields;
  final double? reliabilityScore;
  final bool reliabilityHasHistory;
  final String? exclusionReason;

  bool get isSelected => status == QuoteStatus.selected;
  bool get isPartial => itemsCovered < itemsRequested;

  /// "4.8" or "No history yet" -- never a fabricated star.
  String get reliabilityLabel => reliabilityHasHistory && reliabilityScore != null
      ? reliabilityScore!.toStringAsFixed(1)
      : 'No history yet';

  /// "Covers 3/3 items" / "Covers 2/3 — no CPU kit" (design 11a).
  String get coverageLabel {
    final base = 'Covers $itemsCovered/$itemsRequested items';
    if (itemsCovered == itemsRequested) return base;
    final missing =
        lines.where((l) => !l.available).map((l) => l.requestItemName).toList();
    if (missing.isEmpty) return base;
    return 'Covers $itemsCovered/$itemsRequested — no ${missing.join(', ')}';
  }

  /// "data confidence 80% (warranty months not specified)".
  String? get confidenceLabel {
    if (confidencePercent == null) return null;
    if (missingFields.isEmpty) return 'data confidence $confidencePercent%';
    final pretty = missingFields.map((f) => f.replaceAll('_', ' ')).join(', ');
    return 'data confidence $confidencePercent% ($pretty not specified)';
  }

  factory Quote.fromJson(Map<String, dynamic> j) {
    final score = j['score'] as Map<String, dynamic>?;
    return Quote(
      id: j['id'] as String,
      vendorId: j['vendor_id'] as String,
      vendorName: j['vendor_name'] as String,
      status: QuoteStatus.parse(j['status'] as String?),
      currency: (j['currency'] ?? 'PKR') as String,
      itemsCovered: _i(j['items_covered']) ?? 0,
      itemsRequested: _i(j['items_requested']) ?? 1,
      lines: ((j['lines'] as List?) ?? const [])
          .map((e) => QuoteLine.fromJson(e as Map<String, dynamic>))
          .toList(),
      components: ((score?['components'] as List?) ?? const [])
          .map((e) => ScoreComponent.fromJson(e as Map<String, dynamic>))
          .toList(),
      totalAmount: _d(j['total_amount']),
      deliveryDays: _i(j['delivery_days']),
      warrantyMonths: _i(j['warranty_months']),
      scoreTotal: _d(j['score_total']) ?? _d(score?['total']),
      confidencePercent: _i(j['confidence_percent']) ??
          _i((score?['confidence'] as Map<String, dynamic>?)?['percent']),
      missingFields: _s(j['missing_fields']),
      reliabilityScore: _d(j['reliability_score']),
      reliabilityHasHistory: (j['reliability_has_history'] ?? false) as bool,
      exclusionReason: j['exclusion_reason'] as String?,
    );
  }
}

// ===========================================================================
// Validation -- screens 6a / 6b
// ===========================================================================
class ValidationCheck {
  const ValidationCheck({
    required this.title,
    required this.outcome,
    required this.message,
    this.expected,
    this.actual,
  });

  final String title;
  final ValidationOutcome outcome;
  final String message;
  final String? expected;
  final String? actual;

  bool get passed => outcome == ValidationOutcome.passed;

  factory ValidationCheck.fromJson(Map<String, dynamic> j) => ValidationCheck(
        title: j['title'] as String,
        outcome: ValidationOutcome.parse(j['outcome'] as String?),
        message: (j['message'] ?? '') as String,
        expected: j['expected'] as String?,
        actual: j['actual'] as String?,
      );
}

class ValidationReport {
  const ValidationReport({
    required this.passed,
    required this.attempt,
    required this.maxAttempts,
    required this.checks,
  });

  final bool passed;
  final int attempt;
  final int maxAttempts;
  final List<ValidationCheck> checks;

  int get passedCount => checks.where((c) => c.passed).length;

  /// "5 of 5 checks passed".
  String get summaryLabel => '$passedCount of ${checks.length} checks passed';

  List<ValidationCheck> get failures =>
      checks.where((c) => c.outcome == ValidationOutcome.failed).toList();

  /// Screen 6b shows the self-correction banner when this is true.
  bool get canSelfCorrect => !passed && attempt < maxAttempts;

  factory ValidationReport.fromJson(Map<String, dynamic> j) => ValidationReport(
        passed: (j['passed'] ?? false) as bool,
        attempt: _i(j['attempt']) ?? 1,
        maxAttempts: _i(j['max_attempts']) ?? 1,
        checks: ((j['checks'] as List?) ?? const [])
            .map((e) => ValidationCheck.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

// ===========================================================================
// Purchase order -- screen 7a
// ===========================================================================
class POLineItem {
  const POLineItem({
    required this.lineNumber,
    required this.description,
    required this.quantity,
    required this.unitPrice,
    required this.lineTotal,
    this.sku,
  });

  final int lineNumber;
  final String description;
  final int quantity;
  final double unitPrice;
  final double lineTotal;
  final String? sku;

  factory POLineItem.fromJson(Map<String, dynamic> j) => POLineItem(
        lineNumber: _i(j['line_number']) ?? 0,
        description: j['description'] as String,
        quantity: _i(j['quantity']) ?? 0,
        unitPrice: _d(j['unit_price']) ?? 0,
        lineTotal: _d(j['line_total']) ?? 0,
        sku: j['sku'] as String?,
      );
}

class PurchaseOrder {
  const PurchaseOrder({
    required this.id,
    required this.poNumber,
    required this.vendorId,
    required this.subtotal,
    required this.tax,
    required this.totalAmount,
    required this.currency,
    required this.deliveryStatus,
    this.nextStates = const [],
    this.closedAt,
    this.closureOutcome,
    this.closureNote,
    this.receivedQuantity,
    required this.generationAttempt,
    required this.lineItems,
    required this.createdAt,
    this.deliveryDays,
    this.warrantyMonths,
    this.expectedDeliveryDate,
    this.paymentTerms,
    this.pdfUrl,
  });

  final String id;
  final String poNumber;
  final String vendorId;
  final double subtotal;
  final double tax;
  final double totalAmount;
  final String currency;
  final PODeliveryStatus deliveryStatus;

  /// What this vendor may move the order to next, as the SERVER sees it.
  ///
  /// Not derived client-side: fulfilment only moves forward, and the rule
  /// that enforces that lives on the backend. Rendering a chip the server
  /// will reject with a 409 teaches the vendor to distrust the buttons.
  final List<PODeliveryStatus> nextStates;

  // -- close-out ------------------------------------------------------
  // The BUYER's record that the order is finished, deliberately separate
  // from deliveryStatus, which is the supplier's own claim about it.
  final DateTime? closedAt;
  final String? closureOutcome;
  final String? closureNote;
  final int? receivedQuantity;

  bool get isClosed => closedAt != null;
  final int generationAttempt;
  final List<POLineItem> lineItems;
  final DateTime createdAt;
  final int? deliveryDays;
  final int? warrantyMonths;
  final DateTime? expectedDeliveryDate;
  final String? paymentTerms;
  final String? pdfUrl;

  int get totalUnits => lineItems.fold(0, (s, l) => s + l.quantity);

  factory PurchaseOrder.fromJson(Map<String, dynamic> j) => PurchaseOrder(
        id: j['id'] as String,
        poNumber: j['po_number'] as String,
        vendorId: (j['vendor_id'] ?? '') as String,
        subtotal: _d(j['subtotal']) ?? 0,
        tax: _d(j['tax']) ?? 0,
        totalAmount: _d(j['total_amount']) ?? 0,
        currency: (j['currency'] ?? 'PKR') as String,
        deliveryStatus: PODeliveryStatus.parse(j['delivery_status'] as String?),
        nextStates: ((j['next_states'] as List?) ?? const [])
            .map((e) => PODeliveryStatus.parse('$e'))
            .toList(),
        closedAt: DateTime.tryParse('${j['closed_at']}')?.toLocal(),
        closureOutcome: j['closure_outcome'] as String?,
        closureNote: j['closure_note'] as String?,
        receivedQuantity: _i(j['received_quantity']),
        generationAttempt: _i(j['generation_attempt']) ?? 1,
        lineItems: ((j['line_items'] as List?) ?? const [])
            .map((e) => POLineItem.fromJson(e as Map<String, dynamic>))
            .toList(),
        createdAt: _t(j['created_at']) ?? DateTime.now(),
        deliveryDays: _i(j['delivery_days']),
        warrantyMonths: _i(j['warranty_months']),
        expectedDeliveryDate: _t(j['expected_delivery_date']),
        paymentTerms: j['payment_terms'] as String?,
        pdfUrl: j['pdf_url'] as String?,
      );
}

// ===========================================================================
// Report and audit -- screens 9a / 10b
// ===========================================================================
class ReportMetric {
  const ReportMetric({
    required this.label,
    required this.value,
    this.emphasis = false,
  });

  final String label;
  final String value;
  final bool emphasis;

  factory ReportMetric.fromJson(Map<String, dynamic> j) => ReportMetric(
        label: j['label'] as String,
        value: (j['value'] ?? '').toString(),
        emphasis: (j['emphasis'] ?? false) as bool,
      );
}

class ReportSection {
  const ReportSection({
    required this.heading,
    required this.body,
    this.bullets = const [],
  });

  final String heading;
  final String body;
  final List<String> bullets;

  factory ReportSection.fromJson(Map<String, dynamic> j) => ReportSection(
        heading: j['heading'] as String,
        body: (j['body'] ?? '') as String,
        bullets: _s(j['bullets']),
      );
}

class CompletionReport {
  const CompletionReport({
    required this.title,
    required this.headline,
    required this.metrics,
    required this.sections,
    required this.decisions,
    required this.caveats,
    required this.stepsExecuted,
    required this.toolsInvoked,
    required this.retriesPerformed,
    this.totalDurationMs,
  });

  final String title;
  final String headline;
  final List<ReportMetric> metrics;
  final List<ReportSection> sections;
  final List<String> decisions;
  final List<String> caveats;
  final int stepsExecuted;
  final int toolsInvoked;
  final int retriesPerformed;
  final int? totalDurationMs;

  factory CompletionReport.fromJson(Map<String, dynamic> j) => CompletionReport(
        title: (j['title'] ?? '') as String,
        headline: (j['headline'] ?? '') as String,
        metrics: ((j['metrics'] as List?) ?? const [])
            .map((e) => ReportMetric.fromJson(e as Map<String, dynamic>))
            .toList(),
        sections: ((j['sections'] as List?) ?? const [])
            .map((e) => ReportSection.fromJson(e as Map<String, dynamic>))
            .toList(),
        decisions: _s(j['decisions']),
        caveats: _s(j['caveats']),
        stepsExecuted: _i(j['steps_executed']) ?? 0,
        toolsInvoked: _i(j['tools_invoked']) ?? 0,
        retriesPerformed: _i(j['retries_performed']) ?? 0,
        totalDurationMs: _i(j['total_duration_ms']),
      );
}

class AuditEvent {
  const AuditEvent({
    required this.at,
    required this.source,
    required this.actor,
    required this.event,
    this.detail,
    this.status,
    this.durationMs,
  });

  final DateTime at;
  final String source;
  final String actor;
  final String event;
  final String? detail;
  final String? status;
  final int? durationMs;

  factory AuditEvent.fromJson(Map<String, dynamic> j) => AuditEvent(
        at: _t(j['at']) ?? DateTime.now(),
        source: (j['source'] ?? '') as String,
        actor: (j['actor'] ?? '') as String,
        event: (j['event'] ?? '') as String,
        detail: j['detail'] as String?,
        status: j['status'] as String?,
        durationMs: _i(j['duration_ms']),
      );
}

// ===========================================================================
// Vendors and catalog -- screens 13a / 15a / 18a / 14a
// ===========================================================================
class VendorReliability {
  const VendorReliability({
    required this.hasHistory,
    required this.ordersFulfilled,
    required this.display,
    this.onTimeRate,
    this.quantityAccuracy,
    this.cancellations = 0,
    this.lateDeliveries = 0,
    this.score,
  });

  final bool hasHistory;
  final int ordersFulfilled;
  final String display;
  final double? onTimeRate;
  final double? quantityAccuracy;
  final int cancellations;
  final int lateDeliveries;
  final double? score;

  factory VendorReliability.fromJson(Map<String, dynamic> j) =>
      VendorReliability(
        hasHistory: (j['has_history'] ?? false) as bool,
        ordersFulfilled: _i(j['orders_fulfilled']) ?? 0,
        display: (j['display'] ?? 'No history yet') as String,
        onTimeRate: _d(j['on_time_rate']),
        quantityAccuracy: _d(j['quantity_accuracy']),
        cancellations: _i(j['cancellations']) ?? 0,
        lateDeliveries: _i(j['late_deliveries']) ?? 0,
        score: _d(j['score']),
      );
}

class VendorFlag {
  const VendorFlag({
    required this.reason,
    required this.detail,
    required this.raisedAt,
  });

  final String reason;
  final String detail;
  final DateTime raisedAt;

  factory VendorFlag.fromJson(Map<String, dynamic> j) => VendorFlag(
        reason: (j['reason'] ?? '') as String,
        detail: (j['detail'] ?? '') as String,
        raisedAt: _t(j['raised_at']) ?? DateTime.now(),
      );
}

class Vendor {
  const Vendor({
    required this.id,
    required this.name,
    required this.status,
    required this.reliability,
    required this.flags,
    this.category,
    this.email,
    this.phone,
    this.defaultDeliveryDays,
    this.defaultWarrantyMonths,
    this.lastPublishedAt,
  });

  final String id;
  final String name;
  final VendorStatus status;
  final VendorReliability reliability;
  final List<VendorFlag> flags;
  final String? category;
  final String? email;
  final String? phone;
  final int? defaultDeliveryDays;
  final int? defaultWarrantyMonths;
  final DateTime? lastPublishedAt;

  bool get isFlagged => flags.isNotEmpty;

  factory Vendor.fromJson(Map<String, dynamic> j) => Vendor(
        id: j['id'] as String,
        name: j['name'] as String,
        status: VendorStatus.parse(j['status'] as String?),
        reliability: VendorReliability.fromJson(
          (j['reliability'] as Map<String, dynamic>?) ?? const {},
        ),
        flags: ((j['flags'] as List?) ?? const [])
            .map((e) => VendorFlag.fromJson(e as Map<String, dynamic>))
            .toList(),
        category: j['category'] as String?,
        email: j['email'] as String?,
        phone: j['phone'] as String?,
        defaultDeliveryDays: _i(j['default_delivery_days']),
        defaultWarrantyMonths: _i(j['default_warranty_months']),
        lastPublishedAt: _t(j['last_published_at']),
      );
}

class CatalogItem {
  const CatalogItem({
    required this.id,
    required this.vendorId,
    required this.sku,
    required this.title,
    required this.price,
    required this.effectivePrice,
    required this.currency,
    required this.stock,
    required this.isLowStock,
    required this.visible,
    required this.hasUnpublishedChanges,
    required this.missingTerms,
    this.vendorName,
    this.description,
    this.category,
    this.brand,
    this.salePrice,
    this.deliveryDays,
    this.warrantyMonths,
    this.publishedAt,
  });

  final String id;
  final String vendorId;
  final String sku;
  final String title;
  final double price;
  final double effectivePrice;
  final String currency;
  final int stock;
  final bool isLowStock;
  final bool visible;
  final bool hasUnpublishedChanges;
  final List<String> missingTerms;
  final String? vendorName;
  final String? description;
  final String? category;
  final String? brand;
  final double? salePrice;
  final int? deliveryDays;
  final int? warrantyMonths;
  final DateTime? publishedAt;

  factory CatalogItem.fromJson(Map<String, dynamic> j) => CatalogItem(
        id: j['id'] as String,
        vendorId: j['vendor_id'] as String,
        sku: j['sku'] as String,
        title: j['title'] as String,
        price: _d(j['price']) ?? 0,
        effectivePrice: _d(j['effective_price']) ?? _d(j['price']) ?? 0,
        currency: (j['currency'] ?? 'PKR') as String,
        stock: _i(j['stock']) ?? 0,
        isLowStock: (j['is_low_stock'] ?? false) as bool,
        visible: (j['visible'] ?? true) as bool,
        hasUnpublishedChanges: (j['has_unpublished_changes'] ?? false) as bool,
        missingTerms: _s(j['missing_terms']),
        vendorName: j['vendor_name'] as String?,
        description: j['description'] as String?,
        category: j['category'] as String?,
        brand: j['brand'] as String?,
        salePrice: _d(j['sale_price']),
        deliveryDays: _i(j['delivery_days']),
        warrantyMonths: _i(j['warranty_months']),
        publishedAt: _t(j['published_at']),
      );
}

class CatalogDraftState {
  const CatalogDraftState({
    required this.unsavedChangeCount,
    required this.itemsMissingTerms,
    required this.statusLine,
    this.lastPublishedAt,
  });

  final int unsavedChangeCount;
  final int itemsMissingTerms;

  /// "Last published: today, 08:15 AM · 2 unsaved changes" (design 14a).
  final String statusLine;
  final DateTime? lastPublishedAt;

  factory CatalogDraftState.fromJson(Map<String, dynamic> j) =>
      CatalogDraftState(
        unsavedChangeCount: _i(j['unsaved_change_count']) ?? 0,
        itemsMissingTerms: _i(j['items_missing_terms']) ?? 0,
        statusLine: (j['status_line'] ?? '') as String,
        lastPublishedAt: _t(j['last_published_at']),
      );
}

// ===========================================================================
// Approvals -- screens 8a / 8b / 12a
// ===========================================================================
class Approval {
  const Approval({
    required this.id,
    required this.workflowId,
    required this.decision,
    required this.requestedAt,
    required this.title,
    this.purchaseOrderId,
    this.poNumber,
    this.totalAmount,
    this.currency,
    this.budget,
    this.decidedAt,
    this.comment,
    this.vendorName,
    this.requesterName,
    this.decidedByName,
    this.justification,
    this.pdfUrl,
    this.lineItems = const [],
    this.canDecide = false,
    this.requestText,
    this.deliveryDays,
    this.warrantyMonths,
  });

  final String id;
  final String workflowId;
  final String decision;
  final DateTime requestedAt;
  final String title;
  final String? purchaseOrderId;
  final String? poNumber;
  final double? totalAmount;
  final String? currency;
  final double? budget;
  final DateTime? decidedAt;
  final String? comment;

  /// Screen 12a heads the line-item card `Line items - [vendorName]`.
  final String? vendorName;

  /// "requested by S. Ahmed" on the 12a banner.
  final String? requesterName;
  final String? decidedByName;

  /// The agent's stated reason for its choice. An approver signing off on a
  /// decision they cannot see the reasoning for is the thing this whole
  /// screen exists to prevent.
  final String? justification;

  /// Signed, short-lived link to the stored PO. Null when Storage is down --
  /// the approval stays reviewable without it.
  final String? pdfUrl;

  /// Populated only by the detail endpoint; the queue omits them.
  final List<POLineItem> lineItems;

  /// False for an employee watching their own request. Seeing the gate is not
  /// the same permission as clearing it.
  final bool canDecide;

  final String? requestText;
  final int? deliveryDays;
  final int? warrantyMonths;

  bool get isPending => decision == 'pending';
  bool get hasDetail => lineItems.isNotEmpty || justification != null;

  /// "94% of budget" -- shown on 12a.
  int? get budgetUtilisation {
    if (budget == null || budget == 0 || totalAmount == null) return null;
    return ((totalAmount! / budget!) * 100).round();
  }

  /// Parses BOTH shapes: the flat queue row and the nested detail response.
  ///
  /// The detail endpoint mirrors its nested values to the top level for
  /// exactly this reason -- a push notification can launch the detail screen
  /// cold, with no queue row to inherit from.
  factory Approval.fromJson(Map<String, dynamic> j) {
    final po = (j['purchase_order'] as Map?)?.cast<String, dynamic>();
    final wf = (j['workflow'] as Map?)?.cast<String, dynamic>();

    return Approval(
      id: j['id'] as String,
      workflowId: j['workflow_id'] as String,
      decision: (j['decision'] ?? 'pending') as String,
      requestedAt: _t(j['requested_at']) ?? DateTime.now(),
      title: (j['title'] ?? wf?['title'] ?? '') as String,
      purchaseOrderId: (j['purchase_order_id'] ?? po?['id']) as String?,
      poNumber: (j['po_number'] ?? po?['po_number']) as String?,
      totalAmount: _d(j['total_amount'] ?? po?['total_amount']),
      currency: (j['currency'] ?? po?['currency'] ?? wf?['currency']) as String?,
      budget: _d(j['budget'] ?? wf?['budget']),
      decidedAt: _t(j['decided_at']),
      comment: j['comment'] as String?,
      vendorName: (j['vendor_name'] ?? po?['vendor_name']) as String?,
      requesterName: j['requester_name'] as String?,
      decidedByName: j['decided_by_name'] as String?,
      justification: (j['justification'] ?? wf?['justification']) as String?,
      pdfUrl: (j['pdf_url'] ?? po?['pdf_url']) as String?,
      lineItems: ((po?['line_items'] as List?) ?? const [])
          .map((e) => POLineItem.fromJson((e as Map).cast<String, dynamic>()))
          .toList(),
      canDecide: j['can_decide'] as bool? ?? false,
      requestText: wf?['request_text'] as String?,
      deliveryDays: _i(po?['delivery_days']),
      warrantyMonths: _i(po?['warranty_months']),
    );
  }
}

// ===========================================================================
// Admin -- screen 17a
// ===========================================================================
class DashboardStat {
  const DashboardStat({
    required this.key,
    required this.label,
    required this.value,
    required this.tone,
  });

  final String key;
  final String label;
  final String value;
  final String tone;

  factory DashboardStat.fromJson(Map<String, dynamic> j) => DashboardStat(
        key: (j['key'] ?? '') as String,
        label: (j['label'] ?? '') as String,
        value: (j['value'] ?? '').toString(),
        tone: (j['tone'] ?? 'neutral') as String,
      );
}

class AdminDashboard {
  const AdminDashboard({
    required this.stats,
    required this.pendingApprovals,
    required this.activeWorkflows,
    required this.completedThisWeek,
    required this.flaggedVendors,
    required this.totalSpend,
    required this.currency,
  });

  final List<DashboardStat> stats;
  final int pendingApprovals;
  final int activeWorkflows;
  final int completedThisWeek;
  final int flaggedVendors;
  final double totalSpend;
  final String currency;

  factory AdminDashboard.fromJson(Map<String, dynamic> j) => AdminDashboard(
        stats: ((j['stats'] as List?) ?? const [])
            .map((e) => DashboardStat.fromJson(e as Map<String, dynamic>))
            .toList(),
        pendingApprovals: _i(j['pending_approvals']) ?? 0,
        activeWorkflows: _i(j['active_workflows']) ?? 0,
        completedThisWeek: _i(j['completed_this_week']) ?? 0,
        flaggedVendors: _i(j['flagged_vendors']) ?? 0,
        totalSpend: _d(j['total_spend']) ?? 0,
        currency: (j['currency'] ?? 'PKR') as String,
      );
}

class ScoringWeights {
  const ScoringWeights({
    required this.price,
    required this.delivery,
    required this.warranty,
    required this.reliability,
    required this.label,
    required this.isDefault,
  });

  final double price;
  final double delivery;
  final double warranty;
  final double reliability;

  /// "Price 50% · Delivery 30% · Warranty 20%" (design 5a).
  final String label;
  final bool isDefault;

  Map<String, dynamic> toJson() => {
        'price': price,
        'delivery': delivery,
        'warranty': warranty,
        'reliability': reliability,
      };

  factory ScoringWeights.fromJson(Map<String, dynamic> j) => ScoringWeights(
        price: _d(j['price']) ?? 0.5,
        delivery: _d(j['delivery']) ?? 0.3,
        warranty: _d(j['warranty']) ?? 0.2,
        reliability: _d(j['reliability']) ?? 0,
        label: (j['label'] ?? '') as String,
        isDefault: (j['is_default'] ?? true) as bool,
      );
}

// ===========================================================================
// Paged responses
// ===========================================================================
class Paged<T> {
  const Paged({
    required this.items,
    required this.total,
    required this.limit,
    required this.offset,
  });

  final List<T> items;
  final int total;
  final int limit;
  final int offset;

  bool get hasMore => offset + items.length < total;

  factory Paged.fromJson(
    Map<String, dynamic> j,
    T Function(Map<String, dynamic>) parse,
  ) =>
      Paged(
        items: ((j['items'] as List?) ?? const [])
            .map((e) => parse(e as Map<String, dynamic>))
            .toList(),
        total: _i(j['total']) ?? 0,
        limit: _i(j['limit']) ?? 20,
        offset: _i(j['offset']) ?? 0,
      );
}

// ===========================================================================
// Formatting helpers used by the models above
// ===========================================================================
String _titleCase(String s) =>
    s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);

/// "2m ago", "1h ago", "Yesterday" -- exactly the forms the design uses.
String _ago(DateTime t) {
  final d = DateTime.now().difference(t);
  if (d.inMinutes < 1) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes}m ago';
  if (d.inHours < 24) return '${d.inHours}h ago';
  if (d.inDays == 1) return 'Yesterday';
  if (d.inDays < 7) return '${d.inDays}d ago';
  return '${t.day}/${t.month}/${t.year}';
}

extension<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}

// ===========================================================================
// Notifications -- the inbox behind the bell
// ===========================================================================

/// One row of the inbox.
///
/// Written by the backend alongside every push, to the same recipients, so
/// what is here and what arrived on the lock screen cannot disagree.
class AppNotification {
  const AppNotification({
    required this.id,
    required this.kind,
    required this.title,
    required this.body,
    required this.read,
    required this.createdAt,
    this.deepLink,
    this.workflowId,
    this.readAt,
  });

  final String id;

  /// approval_required | approval_decided | po_issued | workflow_escalated
  final String kind;
  final String title;
  final String body;
  final bool read;
  final DateTime createdAt;
  final String? deepLink;
  final String? workflowId;
  final DateTime? readAt;

  /// "Approval needed", "Decision", "New order", "Needs a human".
  String get kindLabel => switch (kind) {
        'approval_required' => 'Approval needed',
        'approval_decided' => 'Decision',
        'po_issued' => 'New order',
        'workflow_escalated' => 'Needs a human',
        _ => 'Update',
      };

  // How a kind is coloured is a presentation decision and lives in the
  // widget layer. This file stays free of Flutter imports so the API models
  // cannot come to depend on the theme.

  /// Where tapping should land, parsed from `agentflow://<kind>/<id>`.
  ({String kind, String id})? get target {
    final raw = deepLink;
    if (raw == null || raw.isEmpty) return null;
    final uri = Uri.tryParse(raw);
    if (uri == null || uri.scheme != 'agentflow') return null;
    final segments = uri.pathSegments;
    if (uri.host.isEmpty || segments.isEmpty) return null;
    return (kind: uri.host, id: segments.first);
  }

  /// "2m", "3h", "Yesterday", "12 Aug".
  String get relativeTime {
    final delta = DateTime.now().difference(createdAt);
    if (delta.inMinutes < 1) return 'now';
    if (delta.inMinutes < 60) return '${delta.inMinutes}m';
    if (delta.inHours < 24) return '${delta.inHours}h';
    if (delta.inDays == 1) return 'Yesterday';
    if (delta.inDays < 7) return '${delta.inDays}d';
    return '${createdAt.day}/${createdAt.month}';
  }

  factory AppNotification.fromJson(Map<String, dynamic> j) => AppNotification(
        id: '${j['id']}',
        kind: '${j['kind'] ?? ''}',
        title: '${j['title'] ?? ''}',
        body: '${j['body'] ?? ''}',
        read: j['read'] as bool? ?? false,
        createdAt:
            DateTime.tryParse('${j['created_at']}')?.toLocal() ?? DateTime.now(),
        deepLink: j['deep_link'] as String?,
        workflowId: j['workflow_id'] as String?,
        readAt: DateTime.tryParse('${j['read_at']}')?.toLocal(),
      );
}

/// The inbox and its unread count, which the server returns together.
class NotificationPage {
  const NotificationPage({required this.items, required this.unreadCount});

  final List<AppNotification> items;
  final int unreadCount;

  factory NotificationPage.fromJson(Map<String, dynamic> j) => NotificationPage(
        items: ((j['items'] as List?) ?? const [])
            .map((e) =>
                AppNotification.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        unreadCount: (j['unread_count'] as num?)?.toInt() ?? 0,
      );
}
