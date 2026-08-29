/// Screen 1a -- Home / Dashboard.
///
/// The opaque gradient hero, three glass stat tiles, and a glass panel of
/// recent workflows. The hero is the one place the design uses a solid
/// gradient rather than glass or clay.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/models.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../widgets/workflow_widgets.dart';
import 'new_request_screen.dart';
import 'workflow_detail_screen.dart';
import 'history_screen.dart';
import '../../widgets/sign_out.dart';
import '../../widgets/notification_bell.dart';
import '../../state/cached.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);
    final workflows = ref.watch(
      workflowListProvider(const WorkflowFilter()),
    );

    return RefreshIndicator(
      color: AppColors.turquoise,
      onRefresh: () async =>
          ref.refresh(workflowListProvider(const WorkflowFilter()).future),
      child: ListView(
        padding: const EdgeInsets.only(top: 8, bottom: 20),
        children: [
          // -- hero ---------------------------------------------------
          Container(
            padding: const EdgeInsets.fromLTRB(18, 20, 18, 18),
            decoration: BoxDecoration(
              gradient: AppGradients.hero,
              borderRadius: BorderRadius.circular(AppRadii.card),
              boxShadow: AppShadows.hero,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Hey ${user?.displayName ?? 'there'} !',
                            style: AppText.caption(const Color(0xFFA2A2AC))
                                .copyWith(fontWeight: FontWeight.w500),
                          ),
                          const SizedBox(height: 3),
                          Text(
                            _greeting(workflows.valueOrNull),
                            style: AppText.hero(AppColors.white),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    const NotificationBell(color: AppColors.white),
                    const SizedBox(width: 4),
                    SignOutAvatar(initials: user?.initials ?? 'AF'),
                  ],
                ),
                const SizedBox(height: 18),
                PrimaryButton(
                  label: 'New Request',
                  icon: Icons.add,
                  height: 54,
                  radius: AppRadii.pill,
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => const NewRequestScreen(),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // -- stat tiles ---------------------------------------------
          workflows.cachedWhen(
            loading: () => const Row(
              children: [
                Expanded(child: SkeletonBox(height: 78, radius: 28)),
                SizedBox(width: 10),
                Expanded(child: SkeletonBox(height: 78, radius: 28)),
                SizedBox(width: 10),
                Expanded(child: SkeletonBox(height: 78, radius: 28)),
              ],
            ),
            error: (_, __) => const SizedBox.shrink(),
            data: (page) {
              final items = page.items;
              final active = items
                  .where((w) =>
                      w.status == WorkflowStatus.running ||
                      w.status == WorkflowStatus.draft)
                  .length;
              final pending = items
                  .where((w) => w.status == WorkflowStatus.awaitingApproval)
                  .length;
              final done = items
                  .where((w) => w.status == WorkflowStatus.completed)
                  .length;
              return Row(
                children: [
                  Expanded(
                    child: StatCard(
                      value: '$active',
                      label: 'Active workflows',
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: StatCard(
                      value: '$pending',
                      label: 'Pending approvals',
                      tone: 'warning',
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: StatCard(
                      value: '$done',
                      label: 'Completed this week',
                      tone: 'positive',
                    ),
                  ),
                ],
              );
            },
          ),
          const SizedBox(height: 16),

          SectionHeader(
            title: 'Recent workflows',
            actionLabel: 'View all',
            onAction: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const HistoryScreen()),
            ),
          ),
          const SizedBox(height: 10),

          workflows.cachedWhen(
            loading: () => const SkeletonBox(height: 220, radius: 28),
            error: (e, __) => ErrorState(
              message: '$e',
              onRetry: () =>
                  ref.invalidate(workflowListProvider(const WorkflowFilter())),
            ),
            data: (page) {
              if (page.items.isEmpty) {
                return const EmptyState(
                  title: 'No workflows yet',
                  message: 'Start by describing what you need in plain English.',
                  icon: Icons.auto_awesome,
                );
              }
              final recent = page.items.take(4).toList();
              return ListPanel(
                children: [
                  for (var i = 0; i < recent.length; i++)
                    WorkflowTile(
                      workflow: recent[i],
                      showDivider: i < recent.length - 1,
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) =>
                              WorkflowDetailScreen(workflowId: recent[i].id),
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }

  /// The design's copy: "Good morning — 2 items need your attention".
  String _greeting(Paged<WorkflowSummary>? page) {
    final hour = DateTime.now().hour;
    final part = hour < 12
        ? 'Good morning'
        : hour < 18
            ? 'Good afternoon'
            : 'Good evening';
    final needing = page?.items
            .where((w) =>
                w.status == WorkflowStatus.awaitingApproval ||
                w.status == WorkflowStatus.escalated)
            .length ??
        0;
    if (needing == 0) return '$part —\nnothing needs your attention';
    return '$part —\n$needing item${needing == 1 ? '' : 's'} '
        'need${needing == 1 ? 's' : ''} your attention';
  }
}
