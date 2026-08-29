/// Quote requests (RFQ) and purchase-order close-out.
///
/// The flow these describe, end to end:
///
///   the agent finds no supplier and escalates
///     -> the buyer asks every verified vendor for a quote
///     -> a vendor answers with priced lines, which publish into the catalog
///        as ordinary items with source 'rfq'
///     -> the buyer re-runs the SAME workflow, and the agent now finds them
///        through the normal catalog path
///
/// Nothing in the agent changes. A quote becomes a catalog row, and the agent
/// only ever reads catalog rows — which is the rule the whole system rests on.
library;

/// One item the buyer asked about, snapshotted from the original request.
class QuoteRequestItem {
  const QuoteRequestItem({
    required this.name,
    required this.quantity,
    this.unit,
    this.specification,
    this.categoryHint,
  });

  final String name;
  final int quantity;
  final String? unit;
  final String? specification;
  final String? categoryHint;

  String get line =>
      '$quantity${unit != null && unit!.isNotEmpty ? ' $unit' : ''} × $name';

  factory QuoteRequestItem.fromJson(Map<String, dynamic> j) => QuoteRequestItem(
        name: '${j['name'] ?? ''}',
        quantity: (j['quantity'] as num?)?.toInt() ?? 0,
        unit: j['unit'] as String?,
        specification: j['specification'] as String?,
        categoryHint: j['category_hint'] as String?,
      );
}

/// One priced line of a vendor's answer.
///
/// Named for the backend schema it mirrors. `QuoteLine` in models.dart is a
/// different thing -- a line of the agent's own supplier quote.
class QuoteResponseLine {
  const QuoteResponseLine({
    required this.requestItemName,
    required this.available,
    this.sku,
    this.title,
    this.unitPrice,
    this.quantity,
    this.deliveryDays,
    this.warrantyMonths,
    this.lineTotal,
  });

  final String requestItemName;

  /// False means "I cannot supply this one". Unavailable lines are recorded
  /// but never published, so they cannot be quoted against later.
  final bool available;
  final String? sku;
  final String? title;
  final double? unitPrice;
  final int? quantity;
  final int? deliveryDays;
  final int? warrantyMonths;
  final double? lineTotal;

  Map<String, dynamic> toJson() => {
        'request_item_name': requestItemName,
        'available': available,
        if (sku != null && sku!.isNotEmpty) 'sku': sku,
        if (title != null && title!.isNotEmpty) 'title': title,
        if (unitPrice != null) 'unit_price': unitPrice,
        if (quantity != null) 'quantity': quantity,
        if (deliveryDays != null) 'delivery_days': deliveryDays,
        if (warrantyMonths != null) 'warranty_months': warrantyMonths,
      };

  factory QuoteResponseLine.fromJson(Map<String, dynamic> j) => QuoteResponseLine(
        requestItemName: '${j['request_item_name'] ?? ''}',
        available: j['available'] as bool? ?? false,
        sku: j['sku'] as String?,
        title: j['title'] as String?,
        unitPrice: (j['unit_price'] as num?)?.toDouble(),
        quantity: (j['quantity'] as num?)?.toInt(),
        deliveryDays: (j['delivery_days'] as num?)?.toInt(),
        warrantyMonths: (j['warranty_months'] as num?)?.toInt(),
        lineTotal: (j['line_total'] as num?)?.toDouble(),
      );
}

/// One vendor's row against a request.
///
/// A row exists from the moment they are invited, so silence is visible: an
/// `invited` row that never became `responded` is information the buyer needs.
class QuoteResponse {
  const QuoteResponse({
    required this.id,
    required this.vendorId,
    required this.status,
    required this.lines,
    required this.publishedToCatalog,
    required this.invitedAt,
    this.vendorName,
    this.totalAmount,
    this.currency,
    this.deliveryDays,
    this.warrantyMonths,
    this.note,
    this.declineReason,
    this.respondedAt,
  });

  final String id;
  final String vendorId;

  /// invited | responded | declined
  final String status;
  final List<QuoteResponseLine> lines;

  /// Only a published response can be picked up by a re-run.
  final bool publishedToCatalog;
  final DateTime invitedAt;
  final String? vendorName;
  final double? totalAmount;
  final String? currency;
  final int? deliveryDays;
  final int? warrantyMonths;
  final String? note;
  final String? declineReason;
  final DateTime? respondedAt;

  bool get hasResponded => status == 'responded';
  bool get hasDeclined => status == 'declined';
  bool get isWaiting => status == 'invited';

  String get statusLabel => switch (status) {
        'responded' => 'Quoted',
        'declined' => 'Declined',
        _ => 'Waiting',
      };

  factory QuoteResponse.fromJson(Map<String, dynamic> j) => QuoteResponse(
        id: '${j['id']}',
        vendorId: '${j['vendor_id']}',
        status: '${j['status'] ?? 'invited'}',
        lines: ((j['lines'] as List?) ?? const [])
            .map((e) => QuoteResponseLine.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        publishedToCatalog: j['published_to_catalog'] as bool? ?? false,
        invitedAt:
            DateTime.tryParse('${j['invited_at']}')?.toLocal() ?? DateTime.now(),
        vendorName: j['vendor_name'] as String?,
        totalAmount: (j['total_amount'] as num?)?.toDouble(),
        currency: j['currency'] as String?,
        deliveryDays: (j['delivery_days'] as num?)?.toInt(),
        warrantyMonths: (j['warranty_months'] as num?)?.toInt(),
        note: j['note'] as String?,
        declineReason: j['decline_reason'] as String?,
        respondedAt: DateTime.tryParse('${j['responded_at']}')?.toLocal(),
      );
}

/// A request for quotes against one workflow.
class QuoteRequest {
  const QuoteRequest({
    required this.id,
    required this.workflowId,
    required this.status,
    required this.items,
    required this.currency,
    required this.responses,
    required this.invitedCount,
    required this.respondedCount,
    required this.summaryLine,
    required this.isActionable,
    required this.createdAt,
    this.workflowTitle,
    this.reason,
    this.note,
    this.budget,
    this.closesAt,
    this.closedAt,
    this.myResponse,
  });

  final String id;
  final String workflowId;

  /// open | closed | cancelled | expired
  final String status;
  final List<QuoteRequestItem> items;
  final String currency;
  final List<QuoteResponse> responses;
  final int invitedCount;
  final int respondedCount;

  /// "Asked 4 suppliers · 2 replied · 1 declined" — server-composed.
  final String summaryLine;

  /// At least one vendor answered AND published. This is the gate on
  /// re-running: without a published quote the agent would find nothing and
  /// escalate again, which teaches the buyer the button is broken.
  final bool isActionable;

  final DateTime createdAt;
  final String? workflowTitle;

  /// The escalation reason the buyer is asking about.
  final String? reason;
  final String? note;
  final double? budget;
  final DateTime? closesAt;
  final DateTime? closedAt;

  /// Vendor view only. A supplier never sees a competitor's quote, so the
  /// vendor listing returns just their own row here and an empty [responses].
  final QuoteResponse? myResponse;

  bool get isOpen => status == 'open';
  bool get isExpired => status == 'expired';

  /// "closes in 34h" / "closed".
  String? get deadlineLabel {
    final at = closesAt;
    if (at == null) return null;
    final left = at.difference(DateTime.now());
    if (left.isNegative) return 'deadline passed';
    if (left.inHours < 1) return 'closes in ${left.inMinutes}m';
    if (left.inHours < 48) return 'closes in ${left.inHours}h';
    return 'closes in ${left.inDays}d';
  }

  factory QuoteRequest.fromJson(Map<String, dynamic> j) => QuoteRequest(
        id: '${j['id']}',
        workflowId: '${j['workflow_id']}',
        status: '${j['status'] ?? 'open'}',
        items: ((j['items'] as List?) ?? const [])
            .map((e) =>
                QuoteRequestItem.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        currency: '${j['currency'] ?? 'PKR'}',
        responses: ((j['responses'] as List?) ?? const [])
            .map((e) =>
                QuoteResponse.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        invitedCount: (j['invited_count'] as num?)?.toInt() ?? 0,
        respondedCount: (j['responded_count'] as num?)?.toInt() ?? 0,
        summaryLine: '${j['summary_line'] ?? ''}',
        isActionable: j['is_actionable'] as bool? ?? false,
        createdAt:
            DateTime.tryParse('${j['created_at']}')?.toLocal() ?? DateTime.now(),
        workflowTitle: j['workflow_title'] as String?,
        reason: j['reason'] as String?,
        note: j['note'] as String?,
        budget: (j['budget'] as num?)?.toDouble(),
        closesAt: DateTime.tryParse('${j['closes_at']}')?.toLocal(),
        closedAt: DateTime.tryParse('${j['closed_at']}')?.toLocal(),
        myResponse: (j['my_response'] as Map?) == null
            ? null
            : QuoteResponse.fromJson(
                (j['my_response'] as Map).cast<String, dynamic>()),
      );
}

/// How a buyer closed a purchase order.
enum POClosureOutcome {
  completed('completed', 'Completed'),
  completedWithIssues('completed_with_issues', 'Completed with issues'),
  cancelled('cancelled', 'Cancelled');

  const POClosureOutcome(this.wire, this.label);

  final String wire;
  final String label;

  /// The backend refuses a blank note on anything but a clean completion —
  /// closing an order as problematic without saying why is not a record.
  bool get requiresNote => this != POClosureOutcome.completed;

  static POClosureOutcome? fromWire(String? wire) {
    if (wire == null) return null;
    for (final o in POClosureOutcome.values) {
      if (o.wire == wire) return o;
    }
    return null;
  }
}
