/// Riverpod providers: configuration, auth session, the API client and the
/// per-screen data providers.
///
/// Auth is Supabase. The app never mints or verifies a token itself -- it
/// holds the session, hands the access token to the API client, and lets the
/// backend decide what the role may do.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart' as sb;

import '../api/api_client.dart';
import '../api/import_models.dart';
import '../api/rfq_models.dart';
import '../api/models.dart';

// ===========================================================================
// Configuration
// ===========================================================================
/// Supabase project credentials, injectable at build time.
///
///   flutter run \
///     --dart-define=SUPABASE_URL=https://xxx.supabase.co \
///     --dart-define=SUPABASE_ANON_KEY=sb_publishable_xxx \
///     --dart-define=API_BASE_URL=https://api.example.com
class SupabaseConfig {
  static const url = String.fromEnvironment(
    'SUPABASE_URL',
    defaultValue: 'https://jbdrqulyenfwzouoktxu.supabase.co',
  );

  /// The publishable key is designed to be shipped in a client; it grants
  /// nothing beyond what RLS allows. The SECRET key never appears here.
  static const anonKey = String.fromEnvironment(
    'SUPABASE_ANON_KEY',
    defaultValue: 'sb_publishable_VX9zf91woOUl6Wk_hTbfPA_g495DDwi',
  );

  static bool get isConfigured => url.isNotEmpty && anonKey.isNotEmpty;
}

final apiConfigProvider = Provider<ApiConfig>(
  (ref) => ApiConfig.fromEnvironment(),
);

// ===========================================================================
// Auth
// ===========================================================================
class AuthState {
  const AuthState({this.user, this.loading = false, this.error});

  final AppUser? user;
  final bool loading;
  final String? error;

  bool get isSignedIn => user != null;

  AuthState copyWith({
    AppUser? user,
    bool? loading,
    String? error,
    bool clearUser = false,
    bool clearError = false,
  }) =>
      AuthState(
        user: clearUser ? null : (user ?? this.user),
        loading: loading ?? this.loading,
        error: clearError ? null : (error ?? this.error),
      );
}

class AuthController extends StateNotifier<AuthState> {
  AuthController() : super(const AuthState()) {
    _restore();
  }

  sb.SupabaseClient get _client => sb.Supabase.instance.client;

  /// Rehydrate from the persisted session so a returning user skips login.
  void _restore() {
    final session = _client.auth.currentSession;
    if (session != null) {
      state = AuthState(user: _userFrom(session.user));
    }
    _client.auth.onAuthStateChange.listen((event) {
      final u = event.session?.user;
      state = u == null
          ? const AuthState()
          : state.copyWith(user: _userFrom(u), clearError: true);
    });
  }

  /// Build the app user from the JWT's metadata.
  ///
  /// Role lives in `app_metadata` (server-controlled) with a `user_metadata`
  /// fallback for accounts created before the hook was in place. The BACKEND
  /// re-derives role from its own users table on every request, so a tampered
  /// client claim grants nothing -- this is only for choosing which screens
  /// to show.
  AppUser _userFrom(sb.User u) {
    final app = u.appMetadata;
    final meta = u.userMetadata ?? const {};
    return AppUser(
      id: u.id,
      email: u.email ?? '',
      role: UserRole.parse(
        (app['role'] ?? meta['role'])?.toString(),
      ),
      fullName: meta['full_name']?.toString(),
      orgId: (app['org_id'] ?? meta['org_id'])?.toString(),
    );
  }

  Future<bool> signIn(String email, String password) async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      final res = await _client.auth.signInWithPassword(
        email: email.trim(),
        password: password,
      );
      if (res.user == null) {
        state = state.copyWith(loading: false, error: 'Sign-in failed.');
        return false;
      }
      state = AuthState(user: _userFrom(res.user!));
      return true;
    } on sb.AuthException catch (e) {
      state = state.copyWith(loading: false, error: e.message);
      return false;
    } catch (e) {
      state = state.copyWith(
        loading: false,
        error: 'Could not reach the sign-in service.',
      );
      return false;
    }
  }

  Future<bool> signUp({
    required String email,
    required String password,
    required String fullName,
    UserRole role = UserRole.employee,
  }) async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      final res = await _client.auth.signUp(
        email: email.trim(),
        password: password,
        data: {'full_name': fullName, 'role': role.name},
      );
      if (res.user == null) {
        state = state.copyWith(loading: false, error: 'Sign-up failed.');
        return false;
      }
      state = AuthState(user: _userFrom(res.user!));
      return true;
    } on sb.AuthException catch (e) {
      state = state.copyWith(loading: false, error: e.message);
      return false;
    }
  }

  Future<void> signOut() async {
    // Clear locally FIRST so the UI leaves at once.
    //
    // Supabase's signOut is a round trip to revoke the refresh token, and on
    // a link to Tokyo that is seconds during which the screen does not move.
    // A sign-out that appears to do nothing reads as broken and gets tapped
    // again. The session is already unusable the moment this state clears, so
    // the revocation is finished behind the user rather than in front of them.
    state = const AuthState();
    try {
      await _client.auth.signOut();
    } catch (e) {
      // The local session is gone regardless. Failing to revoke server-side
      // must never strand somebody in an app that still looks signed in.
      debugPrint('auth: server sign-out failed — $e');
    }
  }

  /// Current access token, refreshed by the SDK as needed.
  Future<String?> accessToken() async =>
      _client.auth.currentSession?.accessToken;
}

final authProvider =
    StateNotifierProvider<AuthController, AuthState>((ref) => AuthController());

final currentUserProvider = Provider<AppUser?>(
  (ref) => ref.watch(authProvider).user,
);

// ===========================================================================
// API client
// ===========================================================================
final apiClientProvider = Provider<ApiClient>((ref) {
  final auth = ref.watch(authProvider.notifier);
  return ApiClient(
    config: ref.watch(apiConfigProvider),
    tokenProvider: auth.accessToken,
    // An expired token has exactly one useful response: sign in again.
    onUnauthorised: () => auth.signOut(),
  );
});

// ===========================================================================
// Data providers
// ===========================================================================
/// Data providers.
///
/// Deliberately NOT autoDispose. The API is about a second away, so throwing a
/// screen's data away the moment you navigate off it means every return trip
/// is a spinner over data that has not changed. These keep their last value,
/// render it instantly, and revalidate behind it -- see state/cached.dart.
///
/// Every mutation already invalidates what it affects, so a stale value has a
/// bounded life. importTemplate and health stay autoDispose: one is static,
/// the other is a diagnostic that must always be live.
final workflowListProvider =
    FutureProvider.family<Paged<WorkflowSummary>, WorkflowFilter>(
  (ref, filter) => ref.watch(apiClientProvider).listWorkflows(
        status: filter.status,
        workflowType: filter.workflowType,
        search: filter.search,
      ),
);

class WorkflowFilter {
  const WorkflowFilter({this.status, this.workflowType, this.search});

  final String? status;
  final String? workflowType;
  final String? search;

  @override
  bool operator ==(Object other) =>
      other is WorkflowFilter &&
      other.status == status &&
      other.workflowType == workflowType &&
      other.search == search;

  @override
  int get hashCode => Object.hash(status, workflowType, search);
}

final workflowDetailProvider =
    FutureProvider.family<WorkflowDetail, String>(
  (ref, id) => ref.watch(apiClientProvider).getWorkflow(id),
);

final comparisonProvider =
    FutureProvider.family<List<Quote>, String>(
  (ref, id) => ref.watch(apiClientProvider).getComparison(id),
);

final validationProvider =
    FutureProvider.family<ValidationReport, String>(
  (ref, id) => ref.watch(apiClientProvider).getValidation(id),
);

final purchaseOrderProvider =
    FutureProvider.family<PurchaseOrder, String>(
  (ref, id) => ref.watch(apiClientProvider).getPurchaseOrder(id),
);

final reportProvider =
    FutureProvider.family<CompletionReport, String>(
  (ref, id) => ref.watch(apiClientProvider).getReport(id),
);

final auditProvider =
    FutureProvider.family<List<AuditEvent>, String>(
  (ref, id) => ref.watch(apiClientProvider).getAudit(id),
);

final vendorListProvider =
    FutureProvider.family<Paged<Vendor>, String?>(
  (ref, status) => ref.watch(apiClientProvider).listVendors(status: status),
);

final catalogBrowseProvider =
    FutureProvider.family<List<CatalogItem>, String?>(
  (ref, search) => ref.watch(apiClientProvider).browseCatalog(search: search),
);

typedef MyCatalog = ({List<CatalogItem> items, CatalogDraftState draft});

final myCatalogProvider = FutureProvider<MyCatalog>(
  (ref) => ref.watch(apiClientProvider).myCatalog(),
);

final approvalsProvider = FutureProvider<Paged<Approval>>(
  (ref) => ref.watch(apiClientProvider).listApprovals(),
);

/// The full approval, fetched by id.
///
/// The queue row carries only a summary, so screen 12a cannot be built from
/// it. This is also the path a push notification takes on a cold launch,
/// where there is no queue in memory to inherit a row from.
/// The number on the bell.
///
/// Its own provider, separate from the inbox, because it is watched on every
/// screen and must not drag a list of rows nobody is rendering along with it.
final unreadCountProvider = FutureProvider<int>(
  (ref) => ref.watch(apiClientProvider).unreadNotificationCount(),
);

final notificationsProvider = FutureProvider<NotificationPage>(
  (ref) => ref.watch(apiClientProvider).notifications(),
);

final approvalDetailProvider =
    FutureProvider.family<Approval, String>(
  (ref, id) => ref.watch(apiClientProvider).getApproval(id),
);

final dashboardProvider = FutureProvider<AdminDashboard>(
  (ref) => ref.watch(apiClientProvider).getDashboard(),
);

final scoringWeightsProvider = FutureProvider<ScoringWeights>(
  (ref) => ref.watch(apiClientProvider).getScoringWeights(),
);

final myPurchaseOrdersProvider =
    FutureProvider<Paged<PurchaseOrder>>(
  (ref) => ref.watch(apiClientProvider).myPurchaseOrders(),
);

final connectionsProvider =
    FutureProvider<List<CatalogConnection>>(
  (ref) => ref.watch(apiClientProvider).listConnections(),
);

final importHistoryProvider = FutureProvider<List<ImportJob>>(
  (ref) => ref.watch(apiClientProvider).listImports(),
);

/// The target columns, their examples and the starter CSV. Server-driven so
/// the form a vendor sees can never disagree with what the validator accepts.
final importTemplateProvider =
    FutureProvider.autoDispose<Map<String, dynamic>>(
  (ref) => ref.watch(apiClientProvider).importTemplate(),
);

// -- admin -----------------------------------------------------------------
// Each of these has had a backend endpoint since the first cut and no screen
// calling it. They are separate providers rather than one aggregate so a
// panel that fails -- spend, say -- does not blank the rest of the dashboard.
final spendReportProvider =
    FutureProvider.family<Map<String, dynamic>, int>(
  (ref, days) => ref.watch(apiClientProvider).getSpendReport(days: days),
);

final policyRulesProvider =
    FutureProvider<List<Map<String, dynamic>>>(
  (ref) => ref.watch(apiClientProvider).listPolicyRules(),
);

final flaggedVendorsProvider =
    FutureProvider<List<Map<String, dynamic>>>(
  (ref) => ref.watch(apiClientProvider).flaggedVendors(),
);

final vendorDetailProvider =
    FutureProvider.family<Vendor, String>(
  (ref, id) => ref.watch(apiClientProvider).getVendor(id),
);

// -- quote requests (RFQ) --------------------------------------------------

/// The latest quote request for a workflow, or null when none was raised.
///
/// Null is the ordinary case: most workflows find a supplier and never need
/// to ask. The escalation screen uses null to decide between offering the
/// button and showing the request that is already out.
final workflowQuoteRequestProvider =
    FutureProvider.family<QuoteRequest?, String>(
  (ref, workflowId) =>
      ref.watch(apiClientProvider).quoteRequestForWorkflow(workflowId),
);

/// A vendor's invitations.
final myQuoteRequestsProvider = FutureProvider<List<QuoteRequest>>(
  (ref) => ref.watch(apiClientProvider).myQuoteRequests(),
);

/// Open invitations awaiting an answer -- the vendor portal badge.
final openQuoteCountProvider = FutureProvider<int>(
  (ref) => ref.watch(apiClientProvider).openQuoteRequestCount(),
);

final quoteRequestProvider = FutureProvider.family<QuoteRequest, String>(
  (ref, id) => ref.watch(apiClientProvider).quoteRequest(id),
);

final healthProvider = FutureProvider.autoDispose<Map<String, dynamic>>(
  (ref) => ref.watch(apiClientProvider).health(),
);
