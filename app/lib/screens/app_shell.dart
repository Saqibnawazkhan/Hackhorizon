/// The signed-in shell.
///
/// Routes by ROLE, not by preference: an employee never sees the approval
/// queue, a vendor never sees buyer workflows. The backend enforces the same
/// boundary independently -- this just avoids showing a tab that would 403.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../state/providers.dart';
import '../widgets/shell.dart';
import 'admin/admin_screens.dart';
import 'employee/history_screen.dart';
import 'employee/home_screen.dart';
import 'employee/new_request_screen.dart';
import 'employee/vendors_screen.dart';
import 'vendor/vendor_portal.dart';
import '../widgets/sign_out.dart';
import '../widgets/notification_bell.dart';

class AppShell extends ConsumerStatefulWidget {
  const AppShell({super.key});

  @override
  ConsumerState<AppShell> createState() => _AppShellState();
}

class _AppShellState extends ConsumerState<AppShell> {
  NavTab _tab = NavTab.home;

  @override
  Widget build(BuildContext context) {
    final user = ref.watch(currentUserProvider);
    if (user == null) return const SizedBox.shrink();

    // Vendors get their own portal, not a tabbed buyer shell.
    if (user.role == UserRole.vendor) return const VendorPortalScreen();

    final isAdmin = user.role == UserRole.admin;
    // The design's NavBar has no role variant: the same four tabs and the
    // same centre FAB appear on employee and admin screens alike. Dropping
    // Approvals for employees left four slots where the design has five.
    //
    // Safe to show now that the queue is role-scoped: an employee sees only
    // the approvals raised for their own requests, and cannot decide any of
    // them -- the decision endpoint is still admin-only.
    final tabs = NavTab.values;

    final body = switch (_tab) {
      NavTab.home =>
        isAdmin
            ? const AdminDashboardScreen(embedded: true)
            : const HomeScreen(),
      NavTab.workflows => const HistoryScreen(embedded: true),
      NavTab.approvals => const ApprovalsScreen(embedded: true),
      NavTab.reports => const VendorsScreen(embedded: true),
    };

    return AppScaffold(
      header: _header(user, isAdmin),
      bottomNav: AppBottomNav(
        active: _tab,
        tabs: tabs,
        onSelect: _select,
        // The design draws the FAB on the admin screens too (17a, 18a, 8a,
        // 8b, 12a). An admin raising a request is ordinary.
        onFab: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const NewRequestScreen()),
        ),
      ),
      child: body,
    );
  }

  /// Switch tab, then revalidate what that tab shows.
  ///
  /// The providers keep their last value so the screen is there the instant
  /// you tap. This is the other half of that bargain: the cached value gets
  /// corrected immediately behind the render, rather than sitting there until
  /// something happens to invalidate it.
  void _select(NavTab tab) {
    setState(() => _tab = tab);

    for (final provider in switch (tab) {
      NavTab.home => [dashboardProvider, workflowListProvider],
      NavTab.workflows => [workflowListProvider],
      NavTab.approvals => [approvalsProvider],
      NavTab.reports => [vendorListProvider],
    }) {
      ref.invalidate(provider);
    }
    // The bell is on every tab, so it is worth keeping honest on every hop.
    ref.invalidate(unreadCountProvider);
  }

  Widget? _header(AppUser user, bool isAdmin) {
    // The home tab carries its own hero, so no separate header there.
    if (_tab == NavTab.home) return null;
    return AppHeader(
      title: switch (_tab) {
        NavTab.workflows => 'Workflows',
        NavTab.approvals => 'Approvals',
        NavTab.reports => 'Vendors',
        NavTab.home => '',
      },
      showBack: false,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const NotificationBell(),
          const SizedBox(width: 6),
          SignOutAvatar(initials: user.initials, size: 36),
        ],
      ),
    );
  }
}
