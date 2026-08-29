/// The notification inbox.
///
/// What the bell opens. Every row goes where its push would have gone, so a
/// notification you dismissed on the lock screen is not lost — it is here,
/// and tapping it lands on the same approval or workflow.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../state/providers.dart';
import '../theme/app_theme.dart';
import '../theme/surfaces.dart';
import '../theme/tokens.dart';
import '../widgets/common.dart';
import '../widgets/shell.dart';
import 'admin/admin_screens.dart';
import 'employee/workflow_detail_screen.dart';
import '../state/cached.dart';

class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  Future<void> _open(
    BuildContext context,
    WidgetRef ref,
    AppNotification n,
  ) async {
    // Mark read first: the point of tapping is that you have now seen it, and
    // it should not still be counted while the destination loads.
    if (!n.read) {
      try {
        await ref.read(apiClientProvider).markNotificationsRead([n.id]);
        ref.invalidate(unreadCountProvider);
        ref.invalidate(notificationsProvider);
      } on ApiException {
        // Not worth blocking navigation over.
      }
    }
    if (!context.mounted) return;

    final target = n.target;
    if (target == null) return;

    if (target.kind == 'workflows') {
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => WorkflowDetailScreen(workflowId: target.id),
        ),
      );
    } else if (target.kind == 'approvals') {
      try {
        final approval = await ref.read(apiClientProvider).getApproval(target.id);
        if (!context.mounted) return;
        await Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => ApprovalDetailScreen(approval: approval),
          ),
        );
      } on ApiException catch (e) {
        if (context.mounted) showToast(context, e.message, danger: true);
      }
    } else if (n.workflowId != null) {
      // A purchase-order link with nowhere better to go still has a run
      // behind it, which is more useful than doing nothing.
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => WorkflowDetailScreen(workflowId: n.workflowId!),
        ),
      );
    }
  }

  Future<void> _markAll(BuildContext context, WidgetRef ref) async {
    try {
      final marked = await ref.read(apiClientProvider).markNotificationsRead(null);
      ref.invalidate(unreadCountProvider);
      ref.invalidate(notificationsProvider);
      if (context.mounted) {
        showToast(
          context,
          marked == 0 ? 'Nothing unread' : 'Marked $marked as read',
        );
      }
    } on ApiException catch (e) {
      if (context.mounted) showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final inbox = ref.watch(notificationsProvider);

    return AppScaffold(
      header: AppHeader(
        title: 'Notifications',
        subtitle: inbox.maybeWhen(
          data: (page) => page.unreadCount == 0
              ? 'All caught up'
              : '${page.unreadCount} unread',
          orElse: () => null,
        ),
        trailing: inbox.maybeWhen(
          data: (page) => page.unreadCount == 0
              ? null
              : GestureDetector(
                  onTap: () => _markAll(context, ref),
                  behavior: HitTestBehavior.opaque,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 4,
                      vertical: 8,
                    ),
                    child: Text(
                      'Mark all read',
                      style: AppText.captionStrong(AppColors.turquoise),
                    ),
                  ),
                ),
          orElse: () => null,
        ),
      ),
      child: inbox.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(notificationsProvider),
        ),
        data: (page) => page.items.isEmpty
            ? const EmptyState(
                icon: Icons.notifications_none_rounded,
                title: 'Nothing yet',
                message: 'Approvals, decisions and new orders show up here.',
              )
            : RefreshIndicator(
                color: AppColors.turquoise,
                onRefresh: () async {
                  ref.invalidate(unreadCountProvider);
                  return ref.refresh(notificationsProvider.future);
                },
                child: ListView.separated(
                  padding: const EdgeInsets.only(bottom: 24),
                  itemCount: page.items.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 8),
                  itemBuilder: (_, i) => _NotificationCard(
                    notification: page.items[i],
                    onTap: () => _open(context, ref, page.items[i]),
                  ),
                ),
              ),
      ),
    );
  }
}

/// How each kind is coloured. Kept beside the widget that draws it rather
/// than on the model, which stays free of Flutter imports.
extension _NotificationTone on AppNotification {
  PillTone get pillTone => switch (kind) {
        'approval_required' => PillTone.warning,
        'approval_decided' => PillTone.success,
        'po_issued' => PillTone.info,
        'workflow_escalated' => PillTone.danger,
        _ => PillTone.neutral,
      };

  Color get dotColor => switch (kind) {
        'approval_required' => AppColors.warningFg,
        'approval_decided' => AppColors.successFg,
        'po_issued' => AppColors.turquoise,
        'workflow_escalated' => AppColors.dangerFg,
        _ => AppColors.slate,
      };
}

class _NotificationCard extends StatelessWidget {
  const _NotificationCard({required this.notification, required this.onTap});

  final AppNotification notification;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final n = notification;
    return GlassCard(
      onTap: onTap,
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Unread carries a dot; read does not. The design's list rows use
          // the same device for status, so it reads as one vocabulary.
          Container(
            width: 8,
            height: 8,
            margin: const EdgeInsets.only(top: 5, right: 10),
            decoration: BoxDecoration(
              color: n.read ? Colors.transparent : n.dotColor,
              shape: BoxShape.circle,
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        n.title,
                        style: n.read
                            ? AppText.listTitleSm(AppColors.muted)
                            : AppText.listTitleSm(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(n.relativeTime, style: AppText.meta()),
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  n.body,
                  style: AppText.meta(),
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 6),
                StatusPill(
                  label: n.kindLabel,
                  tone: n.pillTone,
                  showDot: false,
                  dense: true,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
