/// AgentFlow — agentic AI for autonomous business workflow execution.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'api/api_client.dart';
import 'screens/admin/admin_screens.dart';
import 'screens/app_shell.dart';
import 'screens/employee/workflow_detail_screen.dart';
import 'services/push.dart';
import 'screens/auth/login_screen.dart';
import 'state/providers.dart';
import 'theme/app_theme.dart';
import 'theme/surfaces.dart';
import 'theme/tokens.dart';
import 'widgets/common.dart';
import 'widgets/shell.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // The design is light-only, so the status bar is pinned to match rather
  // than following the device theme and washing out the header.
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      statusBarBrightness: Brightness.light,
      systemNavigationBarColor: AppColors.white,
      systemNavigationBarIconBrightness: Brightness.dark,
    ),
  );

  String? initError;
  try {
    await Supabase.initialize(
      url: SupabaseConfig.url,
      // Renamed from anonKey in supabase_flutter 2.x.
      publishableKey: SupabaseConfig.anonKey,
      authOptions: const FlutterAuthClientOptions(
        // Persist the session so a returning user skips the login screen.
        autoRefreshToken: true,
      ),
    );
  } catch (e) {
    // Starting without auth is better than a white screen: the error is shown
    // and the rest of the app stays inspectable.
    initError = '$e';
  }

  runApp(ProviderScope(child: AgentFlowApp(initError: initError)));
}

class AgentFlowApp extends StatelessWidget {
  const AgentFlowApp({super.key, this.initError});

  final String? initError;

  /// A notification tap has to push a route from outside any widget's
  /// context -- the app may not have been running when it arrived.
  static final navigatorKey = GlobalKey<NavigatorState>();

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'AgentFlow',
        debugShowCheckedModeBanner: false,
        navigatorKey: navigatorKey,
        theme: AppTheme.light(),
        // The design has no dark variant; committing to light is more honest
        // than inventing one.
        themeMode: ThemeMode.light,
        home: initError != null
            ? _StartupError(message: initError!)
            : const _Root(),
      );
}

/// Chooses between the login screen and the signed-in shell, and owns push.
///
/// Push starts here rather than in `main` because it needs an authenticated
/// client: a device token is registered against a user, and registering it
/// before sign-in would either fail or attach it to nobody.
class _Root extends ConsumerStatefulWidget {
  const _Root();

  @override
  ConsumerState<_Root> createState() => _RootState();
}

class _RootState extends ConsumerState<_Root> {
  StreamSubscription<DeepLink>? _links;
  bool _pushStarted = false;

  @override
  void initState() {
    super.initState();
    _links = PushService.instance.onDeepLink.listen(_openDeepLink);
  }

  @override
  void dispose() {
    _links?.cancel();
    super.dispose();
  }

  /// Opens what the notification was about.
  ///
  /// An approval is fetched by id rather than found in a list, because the
  /// app may have been launched cold by the tap and have no list yet.
  Future<void> _openDeepLink(DeepLink link) async {
    final navigator = AgentFlowApp.navigatorKey.currentState;
    if (navigator == null) return;

    if (link.isWorkflow) {
      await navigator.push(
        MaterialPageRoute(
          builder: (_) => WorkflowDetailScreen(workflowId: link.id),
        ),
      );
      return;
    }

    try {
      final approval = await ref.read(apiClientProvider).getApproval(link.id);
      await navigator.push(
        MaterialPageRoute(
          builder: (_) => ApprovalDetailScreen(approval: approval),
        ),
      );
    } on ApiException catch (e) {
      final context = AgentFlowApp.navigatorKey.currentContext;
      if (context != null && context.mounted) {
        showToast(context, e.message, danger: true);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authProvider);

    // Start push once, after sign-in.
    if (auth.isSignedIn && !_pushStarted) {
      _pushStarted = true;
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => PushService.instance.start(ref.read(apiClientProvider)),
      );
    }

    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 220),
      child: auth.isSignedIn
          ? const AppShell(key: ValueKey('shell'))
          : const LoginScreen(key: ValueKey('login')),
    );
  }
}

class _StartupError extends StatelessWidget {
  const _StartupError({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Scaffold(
        body: PageBackground(
          child: SafeArea(
            child: ErrorState(
              title: 'Could not start',
              message:
                  'Supabase failed to initialise.\n\n$message\n\nCheck '
                  'SUPABASE_URL and SUPABASE_ANON_KEY.',
            ),
          ),
        ),
      );
}
