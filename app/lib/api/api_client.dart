/// Typed HTTP client for the AgentFlow API.
///
/// One method per backend endpoint, returning the models in `models.dart`.
/// Screens never touch dio, never build a URL and never parse JSON -- if the
/// API changes, it changes here and the compiler finds every call site.
///
/// Auth: the Supabase access token is attached by an interceptor, so no caller
/// has to remember it. A 401 clears the session rather than surfacing a raw
/// error, because the only useful response to an expired token is to sign in
/// again.
library;

import 'package:dio/dio.dart';

import 'import_models.dart';
import 'rfq_models.dart';
import 'models.dart';

/// Where the backend lives.
///
/// Overridable at build time so the same binary can point at a laptop, a
/// tunnel or the deployed API:
///   flutter run --dart-define=API_BASE_URL=https://agentflow.up.railway.app
class ApiConfig {
  const ApiConfig({required this.baseUrl});

  final String baseUrl;

  /// 10.0.2.2 is the Android emulator's alias for the host machine's
  /// localhost. A physical phone cannot reach either and needs a real URL.
  static const _default = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:8000',
  );

  factory ApiConfig.fromEnvironment() => const ApiConfig(baseUrl: _default);

  String get apiV1 => '$baseUrl/api/v1';

  /// ws:// for http://, wss:// for https://.
  String wsUrl(String workflowId, {required String token, int lastSeq = 0}) {
    final scheme = baseUrl.startsWith('https') ? 'wss' : 'ws';
    final host = baseUrl.replaceFirst(RegExp(r'^https?://'), '');
    return '$scheme://$host/ws/workflows/$workflowId'
        '?access_token=$token&last_seq=$lastSeq';
  }
}

/// A failure the UI can render. Wraps dio so no screen imports DioException.
class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode, this.code});

  final String message;
  final int? statusCode;
  final String? code;

  bool get isUnauthorised => statusCode == 401;
  bool get isForbidden => statusCode == 403;
  bool get isNotFound => statusCode == 404;

  /// The backend returns 503 with a machine code when a dependency is
  /// unconfigured -- worth telling the user plainly rather than "error".
  bool get isUnavailable => statusCode == 503;

  @override
  String toString() => message;
}

typedef TokenProvider = Future<String?> Function();
typedef UnauthorisedHandler = void Function();

class ApiClient {
  ApiClient({
    required this.config,
    required TokenProvider tokenProvider,
    UnauthorisedHandler? onUnauthorised,
  }) : _dio = Dio(
          BaseOptions(
            baseUrl: config.apiV1,
            connectTimeout: const Duration(seconds: 20),
            // The agent run itself is async, but a Tokyo round trip is ~200ms
            // and some aggregate endpoints do several, so this is generous.
            receiveTimeout: const Duration(seconds: 60),
            sendTimeout: const Duration(seconds: 30),
            headers: {'Content-Type': 'application/json'},
            // Non-2xx is handled by the error mapper, not by throwing raw.
            validateStatus: (s) => s != null && s < 400,
          ),
        ) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          final token = await tokenProvider();
          if (token != null) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          handler.next(options);
        },
        onError: (e, handler) {
          if (e.response?.statusCode == 401) onUnauthorised?.call();
          handler.next(e);
        },
      ),
    );
  }

  final ApiConfig config;
  final Dio _dio;

  // -- plumbing ------------------------------------------------------------
  Never _fail(Object error) {
    if (error is DioException) {
      final status = error.response?.statusCode;
      final data = error.response?.data;

      // The backend's uniform error envelope: {error, message, details}.
      if (data is Map && data['message'] != null) {
        throw ApiException(
          data['message'].toString(),
          statusCode: status,
          code: data['error']?.toString(),
        );
      }
      if (data is Map && data['detail'] != null) {
        throw ApiException(data['detail'].toString(), statusCode: status);
      }
      final message = switch (error.type) {
        DioExceptionType.connectionTimeout ||
        DioExceptionType.sendTimeout ||
        DioExceptionType.receiveTimeout =>
          'The server took too long to respond.',
        DioExceptionType.connectionError =>
          'Cannot reach the server. Check that the API is running and '
              'that API_BASE_URL points at it.',
        _ => error.message ?? 'Request failed',
      };
      throw ApiException(message, statusCode: status);
    }
    throw ApiException(error.toString());
  }

  Future<Map<String, dynamic>> _get(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    try {
      final r = await _dio.get<dynamic>(path, queryParameters: query);
      return (r.data as Map).cast<String, dynamic>();
    } catch (e) {
      _fail(e);
    }
  }

  Future<List<dynamic>> _getList(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    try {
      final r = await _dio.get<dynamic>(path, queryParameters: query);
      return (r.data as List?) ?? const [];
    } catch (e) {
      _fail(e);
    }
  }

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Object? body,
    Map<String, dynamic>? query,
  }) async {
    try {
      final r = await _dio.request<dynamic>(
        path,
        data: body,
        queryParameters: query,
        options: Options(method: method),
      );
      final data = r.data;
      return data is Map ? data.cast<String, dynamic>() : <String, dynamic>{};
    } catch (e) {
      _fail(e);
    }
  }

  // =======================================================================
  // Workflows -- screens 2a, 3a, 4a, 5a, 6a, 7a, 9a, 10a, 10b
  // =======================================================================

  /// Screen 2a. Free text only -- the planner infers the workflow type.
  /// Nothing executes until [runWorkflow].
  Future<WorkflowPlan> createWorkflow(
    String requestText, {
    String? idempotencyKey,
  }) async =>
      WorkflowPlan.fromJson(
        await _send('POST', '/workflows', body: {
          'request_text': requestText,
          if (idempotencyKey != null) 'idempotency_key': idempotencyKey,
        }),
      );

  /// Screen 3a. The user confirmed the plan; execution starts in the
  /// background and progress arrives over the WebSocket.
  Future<void> runWorkflow(String workflowId) async =>
      _send('POST', '/workflows/$workflowId/run');

  /// Screen 10a, and the REST fallback for the live screens.
  Future<Paged<WorkflowSummary>> listWorkflows({
    String? status,
    String? workflowType,
    String? search,
    int limit = 20,
    int offset = 0,
  }) async =>
      Paged.fromJson(
        await _get('/workflows', query: {
          if (status != null) 'status': status,
          if (workflowType != null) 'workflow_type': workflowType,
          if (search != null && search.isNotEmpty) 'search': search,
          'limit': limit,
          'offset': offset,
        }),
        WorkflowSummary.fromJson,
      );

  /// Screens 3a / 4a / 4b. Poll this when the socket is unavailable.
  Future<WorkflowDetail> getWorkflow(String id) async =>
      WorkflowDetail.fromJson(await _get('/workflows/$id'));

  /// Screens 5a and 11a.
  Future<List<Quote>> getComparison(String workflowId) async {
    final data = await _get('/workflows/$workflowId/comparison');
    return ((data['quotes'] as List?) ?? const [])
        .map((e) => Quote.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// Screens 6a and 6b.
  Future<ValidationReport> getValidation(String workflowId) async =>
      ValidationReport.fromJson(await _get('/workflows/$workflowId/validation'));

  /// Screen 7a. `pdfUrl` is a short-lived Supabase signed URL.
  Future<PurchaseOrder> getPurchaseOrder(String workflowId) async =>
      PurchaseOrder.fromJson(
        await _get('/workflows/$workflowId/purchase-order'),
      );

  /// Screen 9a.
  Future<CompletionReport> getReport(String workflowId) async =>
      CompletionReport.fromJson(await _get('/workflows/$workflowId/report'));

  /// Screen 10b.
  Future<List<AuditEvent>> getAudit(String workflowId) async =>
      (await _getList('/workflows/$workflowId/audit'))
          .map((e) => AuditEvent.fromJson(e as Map<String, dynamic>))
          .toList();

  // =======================================================================
  // Approvals -- screens 8a, 8b, 12a
  // =======================================================================
  Future<Paged<Approval>> listApprovals({int limit = 20, int offset = 0}) async =>
      Paged.fromJson(
        await _get('/approvals', query: {'limit': limit, 'offset': offset}),
        Approval.fromJson,
      );

  /// One approval by id. Used by the deep link from a push notification,
  /// where the app may have been launched cold and have no list to search.
  Future<Approval> getApproval(String id) async =>
      Approval.fromJson(await _get('/approvals/$id'));

  /// Screen 8b. The ONLY way a workflow leaves "awaiting approval".
  ///
  /// [idempotencyKey] guards against a double-tap resuming the graph twice.
  Future<Map<String, dynamic>> decideApproval(
    String approvalId, {
    required bool approve,
    String? comment,
    String? idempotencyKey,
  }) async =>
      _send('POST', '/approvals/$approvalId/decision', body: {
        'decision': approve ? 'approved' : 'rejected',
        if (comment != null) 'comment': comment,
        if (idempotencyKey != null) 'idempotency_key': idempotencyKey,
      });

  // =======================================================================
  // Vendors -- screens 13a, 18a
  // =======================================================================
  Future<Paged<Vendor>> listVendors({
    String? status,
    String? search,
    int limit = 20,
    int offset = 0,
  }) async =>
      Paged.fromJson(
        await _get('/vendors', query: {
          if (status != null) 'status': status,
          if (search != null && search.isNotEmpty) 'search': search,
          'limit': limit,
          'offset': offset,
        }),
        Vendor.fromJson,
      );

  Future<Vendor> getVendor(String id) async =>
      Vendor.fromJson(await _get('/vendors/$id'));

  /// Screen 13a. Always lands PENDING -- verification is an admin act.
  Future<Vendor> createVendor({
    required String name,
    String? email,
    String? phone,
    String? category,
    int? defaultDeliveryDays,
    int? defaultWarrantyMonths,
  }) async =>
      Vendor.fromJson(
        await _send('POST', '/vendors', body: {
          'name': name,
          if (email != null) 'email': email,
          if (phone != null) 'phone': phone,
          if (category != null) 'category': category,
          if (defaultDeliveryDays != null)
            'default_delivery_days': defaultDeliveryDays,
          if (defaultWarrantyMonths != null)
            'default_warranty_months': defaultWarrantyMonths,
        }),
      );

  /// Screen 18a: verify / suspend / reinstate.
  Future<Vendor> setVendorStatus(
    String vendorId, {
    required VendorStatus status,
    String? reason,
  }) async =>
      Vendor.fromJson(
        await _send('PATCH', '/vendors/$vendorId/status', body: {
          'status': status.name,
          if (reason != null) 'reason': reason,
        }),
      );

  Future<void> deleteVendor(String vendorId) async =>
      _send('DELETE', '/vendors/$vendorId');

  // -- vendor-side purchase orders ----------------------------------------
  Future<Paged<PurchaseOrder>> myPurchaseOrders({
    String? status,
    int limit = 20,
    int offset = 0,
  }) async =>
      Paged.fromJson(
        await _get('/vendors/me/purchase-orders', query: {
          if (status != null) 'status': status,
          'limit': limit,
          'offset': offset,
        }),
        PurchaseOrder.fromJson,
      );

  /// Feeds reliability scoring -- the score is derived from these updates.
  Future<void> updateDeliveryStatus(
    String poId, {
    required PODeliveryStatus status,
    int? quantityDelivered,
    String? note,
  }) async =>
      _send('PATCH', '/vendors/me/purchase-orders/$poId/delivery', body: {
        'delivery_status': status.wire,
        if (quantityDelivered != null) 'quantity_delivered': quantityDelivered,
        if (note != null) 'note': note,
      });

  // =======================================================================
  // Catalog -- screens 14a, 14b, 14c, 15a
  // =======================================================================

  /// Screen 14a: the vendor's own catalog plus its draft/publish state.
  Future<({List<CatalogItem> items, CatalogDraftState draft})> myCatalog({
    int limit = 100,
    int offset = 0,
  }) async {
    final data = await _get('/catalog/me', query: {
      'limit': limit,
      'offset': offset,
    });
    return (
      items: ((data['items'] as List?) ?? const [])
          .map((e) => CatalogItem.fromJson(e as Map<String, dynamic>))
          .toList(),
      draft: CatalogDraftState.fromJson(
        (data['draft_state'] as Map<String, dynamic>?) ?? const {},
      ),
    );
  }

  /// Screen 14b. Fields left null inherit the vendor profile defaults.
  Future<CatalogItem> createCatalogItem({
    required String sku,
    required String title,
    required double price,
    required int stock,
    String? description,
    String? category,
    String? brand,
    double? salePrice,
    int? deliveryDays,
    int? warrantyMonths,
  }) async =>
      CatalogItem.fromJson(
        await _send('POST', '/catalog/me/items', body: {
          'sku': sku,
          'title': title,
          'price': price,
          'stock': stock,
          if (description != null) 'description': description,
          if (category != null) 'category': category,
          if (brand != null) 'brand': brand,
          if (salePrice != null) 'sale_price': salePrice,
          if (deliveryDays != null) 'delivery_days': deliveryDays,
          if (warrantyMonths != null) 'warranty_months': warrantyMonths,
        }),
      );

  /// Screen 14a inline edits: price and stock steppers.
  Future<CatalogItem> updateCatalogItem(
    String itemId, {
    String? title,
    double? price,
    double? salePrice,
    int? stock,
    int? deliveryDays,
    int? warrantyMonths,
    bool? visible,
  }) async =>
      CatalogItem.fromJson(
        await _send('PATCH', '/catalog/me/items/$itemId', body: {
          if (title != null) 'title': title,
          if (price != null) 'price': price,
          if (salePrice != null) 'sale_price': salePrice,
          if (stock != null) 'stock': stock,
          if (deliveryDays != null) 'delivery_days': deliveryDays,
          if (warrantyMonths != null) 'warranty_months': warrantyMonths,
          if (visible != null) 'visible': visible,
        }),
      );

  Future<void> deleteCatalogItem(String itemId) async =>
      _send('DELETE', '/catalog/me/items/$itemId');

  /// Screen 14a -> 14c. Makes items visible to buyers and to the agent.
  Future<Map<String, dynamic>> publishCatalog({List<String>? itemIds}) async =>
      _send('POST', '/catalog/me/publish', body: {
        if (itemIds != null) 'item_ids': itemIds,
      });

  /// Screen 15a: browse published items from verified vendors.
  Future<List<CatalogItem>> browseCatalog({
    String? vendorId,
    String? search,
    int limit = 50,
    int offset = 0,
  }) async {
    final data = await _get('/catalog/browse', query: {
      if (vendorId != null) 'vendor_id': vendorId,
      if (search != null && search.isNotEmpty) 'search': search,
      'limit': limit,
      'offset': offset,
    });
    return ((data['items'] as List?) ?? const [])
        .map((e) => CatalogItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  // -- catalog connections (dummy adapters) --------------------------------
  Future<List<CatalogConnection>> listConnections() async =>
      (await _getList('/catalog/me/connections'))
          .map((e) =>
              CatalogConnection.fromJson((e as Map).cast<String, dynamic>()))
          .toList();

  /// Credentials are write-only. They go up here and are never returned.
  Future<CatalogConnection> createConnection({
    required String provider,
    required String label,
    String? storeUrl,
    String? apiKey,
    String? apiSecret,
    bool autoSync = false,
  }) async =>
      CatalogConnection.fromJson(
        await _send('POST', '/catalog/me/connections', body: {
          'provider': provider,
          'label': label,
          if (storeUrl != null && storeUrl.isNotEmpty) 'store_url': storeUrl,
          if (apiKey != null && apiKey.isNotEmpty) 'api_key': apiKey,
          if (apiSecret != null && apiSecret.isNotEmpty)
            'api_secret': apiSecret,
          'auto_sync_enabled': autoSync,
        }),
      );

  /// Runs against a seeded fake response -- no real provider call is made.
  Future<CatalogSyncResult> syncConnection(String connectionId) async =>
      CatalogSyncResult.fromJson(
        await _send('POST', '/catalog/me/connections/$connectionId/sync'),
      );

  Future<void> deleteConnection(String connectionId) async =>
      _send('DELETE', '/catalog/me/connections/$connectionId');

  // =======================================================================
  // Spreadsheet import
  //
  // Two calls on purpose. `previewImport` parses and validates and writes
  // nothing, so the vendor sees exactly what will land -- including the rows
  // that will not -- before committing. `commitImport` writes the approved
  // subset; partial import is the default so one bad row does not cost the
  // rest of the file.
  // =======================================================================
  Future<Map<String, dynamic>> importTemplate() async =>
      _get('/imports/template');

  /// Upload a CSV or XLSX. Nothing is written to the catalog by this call.
  Future<ImportPreview> previewImport({
    required String filename,
    required List<int> bytes,
  }) async {
    try {
      final form = FormData.fromMap({
        'file': MultipartFile.fromBytes(bytes, filename: filename),
      });
      final r = await _dio.post<dynamic>('/imports/preview', data: form);
      return ImportPreview.fromJson((r.data as Map).cast<String, dynamic>());
    } catch (e) {
      _fail(e);
    }
  }

  /// Write the approved rows. [mapping] is only sent when the vendor edited
  /// the suggested column mapping -- otherwise the stored one is reused.
  Future<ImportCommitResult> commitImport(
    String jobId, {
    List<ColumnMapping>? mapping,
    bool commitValidOnly = true,
    bool updateExistingSkus = true,
    List<int>? rowNumbers,
  }) async =>
      ImportCommitResult.fromJson(
        await _send('POST', '/imports/$jobId/commit', body: {
          if (mapping != null)
            'mapping': mapping.map((m) => m.toJson()).toList(),
          'commit_valid_only': commitValidOnly,
          'update_existing_skus': updateExistingSkus,
          if (rowNumbers != null) 'row_numbers': rowNumbers,
        }),
      );

  Future<List<ImportJob>> listImports() async {
    final data = await _get('/imports');
    return ((data['items'] as List?) ?? const [])
        .map((e) => ImportJob.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  // =======================================================================
  // Admin -- screens 17a, 18a
  // =======================================================================
  Future<AdminDashboard> getDashboard() async =>
      AdminDashboard.fromJson(await _get('/admin/dashboard'));

  Future<Map<String, dynamic>> getSpendReport({int days = 30}) async =>
      _get('/admin/spend', query: {'days': days});

  Future<ScoringWeights> getScoringWeights() async =>
      ScoringWeights.fromJson(await _get('/admin/scoring-weights'));

  /// Takes effect on the next scored run -- no redeploy.
  Future<ScoringWeights> setScoringWeights(ScoringWeights weights) async =>
      ScoringWeights.fromJson(
        await _send('PUT', '/admin/scoring-weights', body: weights.toJson()),
      );

  Future<List<Map<String, dynamic>>> listPolicyRules() async =>
      (await _getList('/admin/policy-rules'))
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();

  Future<List<Map<String, dynamic>>> flaggedVendors() async =>
      (await _getList('/admin/flagged-vendors'))
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();

  // =======================================================================
  // Quote requests (RFQ)
  //
  // Raised when the agent finds no supplier and escalates. A vendor's answer
  // publishes into the catalog as ordinary items, so re-running the SAME
  // workflow is all it takes for the agent to find them -- the agent itself
  // is untouched.
  // =======================================================================

  /// Ask vendors to quote. Omit [vendorIds] to ask every verified vendor.
  ///
  /// Idempotent in effect: if this workflow already has an open request the
  /// server returns that one rather than inviting everybody twice.
  Future<QuoteRequest> createQuoteRequest(
    String workflowId, {
    List<String>? vendorIds,
    String? note,
    int respondWithinHours = 48,
  }) async =>
      QuoteRequest.fromJson(
        await _send('POST', '/workflows/$workflowId/quote-requests', body: {
          if (vendorIds != null) 'vendor_ids': vendorIds,
          if (note != null && note.isNotEmpty) 'note': note,
          'respond_within_hours': respondWithinHours,
        }),
      );

  /// The latest request for a workflow. 404 when none has been raised.
  Future<QuoteRequest?> quoteRequestForWorkflow(String workflowId) async {
    try {
      return QuoteRequest.fromJson(
        await _get('/workflows/$workflowId/quote-requests'),
      );
    } on ApiException catch (e) {
      // Not an error state: most workflows never need to ask.
      if (e.isNotFound) return null;
      rethrow;
    }
  }

  Future<QuoteRequest> closeQuoteRequest(String requestId) async =>
      QuoteRequest.fromJson(
        await _send('POST', '/quote-requests/$requestId/close'),
      );

  // -- vendor side --------------------------------------------------------

  /// This vendor's invitations. Never includes a competitor's quote.
  Future<List<QuoteRequest>> myQuoteRequests({bool includeClosed = false}) async {
    final data = await _get(
      '/quote-requests/me',
      query: {'include_closed': includeClosed},
    );
    return ((data['items'] as List?) ?? const [])
        .map((e) => QuoteRequest.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  /// Open invitations awaiting an answer -- the vendor portal badge.
  Future<int> openQuoteRequestCount() async {
    final data = await _get('/quote-requests/me/count');
    return (data['open'] as num?)?.toInt() ?? 0;
  }

  Future<QuoteRequest> quoteRequest(String requestId) async =>
      QuoteRequest.fromJson(await _get('/quote-requests/$requestId'));

  /// Answer with priced lines.
  ///
  /// [publishToCatalog] defaults true and should stay true: an unpublished
  /// answer is invisible to the agent, so the buyer's re-run finds nothing.
  Future<({QuoteResponse response, int published, String detail})> respondToQuoteRequest(
    String requestId, {
    required List<QuoteResponseLine> lines,
    String? note,
    int? deliveryDays,
    int? warrantyMonths,
    bool publishToCatalog = true,
  }) async {
    final data = await _send('POST', '/quote-requests/$requestId/respond', body: {
      'lines': lines.map((l) => l.toJson()).toList(),
      if (note != null && note.isNotEmpty) 'note': note,
      if (deliveryDays != null) 'delivery_days': deliveryDays,
      if (warrantyMonths != null) 'warranty_months': warrantyMonths,
      'publish_to_catalog': publishToCatalog,
    });
    return (
      response: QuoteResponse.fromJson(
        (data['response'] as Map).cast<String, dynamic>(),
      ),
      published: (data['catalog_items_published'] as num?)?.toInt() ?? 0,
      detail: '${data['detail'] ?? ''}',
    );
  }

  Future<QuoteResponse> declineQuoteRequest(
    String requestId, {
    String? reason,
  }) async {
    final data = await _send('POST', '/quote-requests/$requestId/decline', body: {
      if (reason != null && reason.isNotEmpty) 'reason': reason,
    });
    return QuoteResponse.fromJson(
      (data['response'] as Map).cast<String, dynamic>(),
    );
  }

  // =======================================================================
  // Purchase-order close-out
  // =======================================================================

  /// Close an order once it has actually been received.
  ///
  /// The buyer's record, deliberately separate from the supplier's delivery
  /// claim: a reliability figure computed only from what the supplier says
  /// about themselves is not a measurement.
  Future<Map<String, dynamic>> closePurchaseOrder(
    String workflowId, {
    POClosureOutcome outcome = POClosureOutcome.completed,
    String? note,
    int? receivedQuantity,
  }) async =>
      _send('POST', '/workflows/$workflowId/purchase-order/close', body: {
        'outcome': outcome.wire,
        if (note != null && note.isNotEmpty) 'note': note,
        if (receivedQuantity != null) 'received_quantity': receivedQuantity,
      });

  // =======================================================================
  // Notifications -- the inbox behind the bell
  // =======================================================================
  Future<NotificationPage> notifications({int limit = 50}) async =>
      NotificationPage.fromJson(
        await _get('/me/notifications', query: {'limit': limit}),
      );

  /// Just the number. Called from every screen, so it is deliberately the
  /// cheapest endpoint in the API rather than a list the caller discards.
  Future<int> unreadNotificationCount() async {
    final data = await _get('/me/notifications/count');
    return (data['unread_count'] as num?)?.toInt() ?? 0;
  }

  /// Pass null to mark everything read.
  Future<int> markNotificationsRead(List<String>? ids) async {
    final data = await _send('POST', '/me/notifications/read', body: {
      if (ids != null) 'notification_ids': ids,
    });
    return (data['marked'] as num?)?.toInt() ?? 0;
  }

  // =======================================================================
  // Push
  //
  // The token identifies this install, not the user, so it is registered
  // after sign-in and removed on sign-out -- otherwise the next person to
  // use the phone receives the previous user's approvals.
  // =======================================================================
  Future<void> registerDevice({
    required String token,
    String platform = 'android',
    String? deviceId,
  }) async =>
      _send('POST', '/me/devices', body: {
        'token': token,
        'platform': platform,
        if (deviceId != null) 'device_id': deviceId,
      });

  Future<void> unregisterDevice({required String token}) async =>
      _send('DELETE', '/me/devices', body: {'token': token});

  // =======================================================================
  // Meta
  // =======================================================================
  Future<Map<String, dynamic>> health() async {
    try {
      final r = await _dio.get<dynamic>(
        '${config.baseUrl}/health',
        options: Options(headers: {'Authorization': null}),
      );
      return (r.data as Map).cast<String, dynamic>();
    } catch (e) {
      _fail(e);
    }
  }
}
