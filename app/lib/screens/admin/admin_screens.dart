/// Admin screens: dashboard (17a), approval queue (8a), approval detail and
/// decision (12a / 8b), and vendor management (18a).
///
/// THE APPROVAL SCREEN IS THE ONLY PLACE SPEND IS COMMITTED. The agent pauses
/// at an interrupt and cannot resume itself; posting a decision here is what
/// releases it.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../widgets/workflow_widgets.dart';
import '../employee/history_screen.dart';
import '../employee/workflow_detail_screen.dart';
import 'admin_tools.dart';
import 'vendor_detail_screen.dart';
import '../../widgets/sign_out.dart';
import '../../widgets/pdf_link.dart';
import '../employee/audit_screen.dart';
import '../../widgets/notification_bell.dart';
import '../../state/cached.dart';

// ===========================================================================
// Screen 17a -- dashboard
// ===========================================================================
class AdminDashboardScreen extends ConsumerWidget {
  const AdminDashboardScreen({super.key, this.embedded = false});

  final bool embedded;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dash = ref.watch(dashboardProvider);
    final user = ref.watch(currentUserProvider);

    final body = dash.cachedWhen(
      loading: () => const LoadingState(),
      error: (e, _) => ErrorState(
        message: '$e',
        onRetry: () => ref.invalidate(dashboardProvider),
      ),
      data: (d) => RefreshIndicator(
        color: AppColors.turquoise,
        onRefresh: () async => ref.refresh(dashboardProvider.future),
        child: ListView(
          padding: const EdgeInsets.only(top: 8, bottom: 24),
          children: [
            Container(
              padding: const EdgeInsets.fromLTRB(18, 18, 18, 18),
              decoration: BoxDecoration(
                gradient: AppGradients.hero,
                borderRadius: BorderRadius.circular(AppRadii.card),
                boxShadow: AppShadows.hero,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Organisation',
                          style: AppText.caption(const Color(0xFFA2A2AC)),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          'Total spend\n${formatMoney(d.totalSpend, d.currency)}',
                          style: AppText.hero(AppColors.white),
                        ),
                      ],
                    ),
                  ),
                  const NotificationBell(color: AppColors.white),
                  const SizedBox(width: 4),
                  SignOutAvatar(initials: user?.initials ?? 'AD'),
                ],
              ),
            ),
            const SizedBox(height: 16),
            GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              mainAxisSpacing: 10,
              crossAxisSpacing: 10,
              childAspectRatio: 1.9,
              children: [
                for (final s in d.stats)
                  StatCard(value: s.value, label: s.label, tone: s.tone),
              ],
            ),
            const SizedBox(height: 16),
            SectionHeader(
              title: 'Approvals',
              actionLabel: d.pendingApprovals > 0 ? 'Review' : null,
              onAction: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const ApprovalsScreen()),
              ),
            ),
            const SizedBox(height: 8),
            if (d.pendingApprovals == 0)
              const InfoBanner(
                message: 'Nothing is waiting on you.',
                tone: PillTone.success,
                icon: Icons.check_circle_outline,
              )
            else
              InfoBanner(
                title: '${d.pendingApprovals} awaiting your decision',
                message:
                    'The agent has paused these runs. They cannot proceed '
                    'until you approve or reject.',
                tone: PillTone.warning,
                icon: Icons.pan_tool_outlined,
              ),
            const SizedBox(height: 16),
            SectionHeader(
              title: 'Vendors',
              actionLabel: 'Manage',
              onAction: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => const VendorManagementScreen(),
                ),
              ),
            ),
            const SizedBox(height: 8),
            if (d.flaggedVendors > 0)
              InfoBanner(
                message:
                    '${d.flaggedVendors} vendor(s) flagged by the performance '
                    'monitor for breaching delivery thresholds.',
                tone: PillTone.danger,
                icon: Icons.flag_outlined,
              ),
            const SizedBox(height: 16),
            const SectionHeader(title: 'Quick actions'),
            const SizedBox(height: 8),
            _QuickActions(flaggedCount: d.flaggedVendors),
            const SizedBox(height: 16),
            const _ScoringWeightsCard(),
          ],
        ),
      ),
    );

    if (embedded) return body;
    return AppScaffold(
      header: const AppHeader(title: 'Admin', subtitle: 'Org-wide overview'),
      child: body,
    );
  }
}

/// Admin-configurable scoring weights. Tapping opens the editor.
class _ScoringWeightsCard extends ConsumerWidget {
  const _ScoringWeightsCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final weights = ref.watch(scoringWeightsProvider);
    return weights.cachedWhen(
      loading: () => const SkeletonBox(height: 96, radius: 28),
      error: (_, __) => const SizedBox.shrink(),
      data: (w) => GlassCard(
        onTap: () => Navigator.of(
          context,
        ).push(MaterialPageRoute(builder: (_) => const ScoringWeightsScreen())),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('Scoring weights', style: AppText.sectionTitle()),
                ),
                if (w.isDefault)
                  const StatusPill(
                    label: 'Default',
                    tone: PillTone.neutral,
                    showDot: false,
                  ),
                const SizedBox(width: 6),
                const Icon(
                  Icons.chevron_right,
                  size: 18,
                  color: AppColors.subtle,
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(w.label, style: AppText.caption()),
            const SizedBox(height: 10),
            Text(
              'These weights drive every comparison. Tap to change them — '
              'it takes effect on the next run, with no redeploy.',
              style: AppText.meta(),
            ),
          ],
        ),
      ),
    );
  }
}

/// Screen 17a's "Quick actions". Every row here is a surface that existed
/// only as an endpoint until now.
class _QuickActions extends StatelessWidget {
  const _QuickActions({required this.flaggedCount});

  final int flaggedCount;

  @override
  Widget build(BuildContext context) => GlassCard(
    padding: const EdgeInsets.symmetric(horizontal: 16),
    child: Column(
      children: [
        _ActionRow(
          icon: Icons.pan_tool_outlined,
          label: 'Review pending approvals',
          onTap: () => Navigator.of(
            context,
          ).push(MaterialPageRoute(builder: (_) => const ApprovalsScreen())),
        ),
        const HairLine(),
        _ActionRow(
          icon: Icons.storefront_outlined,
          label: 'Manage vendors',
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const VendorManagementScreen()),
          ),
        ),
        const HairLine(),
        _ActionRow(
          icon: Icons.flag_outlined,
          label: 'Flagged vendors',
          badge: flaggedCount > 0 ? '$flaggedCount' : null,
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const FlaggedVendorsScreen()),
          ),
        ),
        const HairLine(),
        _ActionRow(
          icon: Icons.bar_chart_outlined,
          label: 'Spend & budget reports',
          onTap: () => Navigator.of(
            context,
          ).push(MaterialPageRoute(builder: (_) => const SpendReportScreen())),
        ),
        const HairLine(),
        _ActionRow(
          icon: Icons.rule_outlined,
          label: 'Expense policy rules',
          onTap: () => Navigator.of(
            context,
          ).push(MaterialPageRoute(builder: (_) => const PolicyRulesScreen())),
        ),
        const HairLine(),
        _ActionRow(
          icon: Icons.history_outlined,
          label: 'Audit trails & activity log',
          onTap: () => Navigator.of(
            context,
          ).push(MaterialPageRoute(builder: (_) => const HistoryScreen())),
        ),
      ],
    ),
  );
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({
    required this.icon,
    required this.label,
    required this.onTap,
    this.badge,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final String? badge;

  @override
  Widget build(BuildContext context) => GestureDetector(
    onTap: () {
      HapticFeedback.selectionClick();
      onTap();
    },
    behavior: HitTestBehavior.opaque,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 13),
      child: Row(
        children: [
          Icon(icon, size: 17, color: AppColors.turquoise),
          const SizedBox(width: 12),
          Expanded(child: Text(label, style: AppText.listTitleSm())),
          if (badge != null) ...[
            StatusPill(
              label: badge!,
              tone: PillTone.danger,
              showDot: false,
              dense: true,
            ),
            const SizedBox(width: 6),
          ],
          const Icon(Icons.chevron_right, size: 18, color: AppColors.subtle),
        ],
      ),
    ),
  );
}

// ===========================================================================
// Screen 8a -- approval queue
// ===========================================================================
class ApprovalsScreen extends ConsumerWidget {
  const ApprovalsScreen({super.key, this.embedded = false});

  final bool embedded;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final approvals = ref.watch(approvalsProvider);

    final body = approvals.cachedWhen(
      loading: () => const LoadingState(),
      error: (e, _) => ErrorState(
        message: '$e',
        onRetry: () => ref.invalidate(approvalsProvider),
      ),
      data: (page) {
        if (page.items.isEmpty) {
          return const EmptyState(
            title: 'Queue is clear',
            message: 'No purchase orders are waiting for a decision.',
            icon: Icons.inbox_outlined,
          );
        }
        return RefreshIndicator(
          color: AppColors.turquoise,
          onRefresh: () async => ref.refresh(approvalsProvider.future),
          child: ListView.separated(
            padding: const EdgeInsets.only(bottom: 24),
            itemCount: page.items.length,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (_, i) {
              final a = page.items[i];
              return GlassCard(
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => ApprovalDetailScreen(approval: a),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(a.title, style: AppText.sectionTitle()),
                        ),
                        const StatusPill(
                          label: 'Pending Approval',
                          tone: PillTone.warning,
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        if (a.poNumber != null) ...[
                          Text(a.poNumber!, style: AppText.mono(11)),
                          Text('  ·  ', style: AppText.meta()),
                        ],
                        Text(
                          formatMoney(a.totalAmount, a.currency ?? 'PKR'),
                          style: AppText.listTitle(AppColors.turquoise),
                        ),
                        const Spacer(),
                        if (a.budgetUtilisation != null)
                          Text(
                            '${a.budgetUtilisation}% of budget',
                            style: AppText.meta(
                              a.budgetUtilisation! > 95
                                  ? AppColors.warningFg
                                  : AppColors.subtle,
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
              );
            },
          ),
        );
      },
    );

    if (embedded) return body;
    return AppScaffold(
      header: AppHeader(
        title: 'Approvals',
        subtitle: approvals.valueOrNull == null
            ? null
            : '${approvals.value!.total} awaiting decision',
      ),
      child: body,
    );
  }
}

// ===========================================================================
// Screen 12a -- full PO detail, and 8b -- the decision
// ===========================================================================
class ApprovalDetailScreen extends ConsumerStatefulWidget {
  const ApprovalDetailScreen({super.key, required this.approval});

  /// The queue row. It carries only a summary, so the screen fetches the full
  /// detail and renders this in the meantime rather than showing a spinner
  /// over information it already has.
  final Approval approval;

  @override
  ConsumerState<ApprovalDetailScreen> createState() =>
      _ApprovalDetailScreenState();
}

class _ApprovalDetailScreenState extends ConsumerState<ApprovalDetailScreen> {
  final _comment = TextEditingController();
  bool _busy = false;
  bool? _decided;

  /// Generated once so a double-tap cannot resume the graph twice.
  late final String _idempotencyKey =
      '${widget.approval.id}-${DateTime.now().millisecondsSinceEpoch}';

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Future<void> _decide(bool approve) async {
    setState(() => _busy = true);
    // Brief: Approve -> mediumImpact, Reject -> heavyImpact.
    if (approve) {
      HapticFeedback.mediumImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    try {
      await ref
          .read(apiClientProvider)
          .decideApproval(
            widget.approval.id,
            approve: approve,
            comment: _comment.text.trim().isEmpty ? null : _comment.text.trim(),
            idempotencyKey: _idempotencyKey,
          );
      ref.invalidate(approvalsProvider);
      ref.invalidate(dashboardProvider);
      ref.invalidate(approvalDetailProvider(widget.approval.id));
      if (!mounted) return;
      setState(() {
        _busy = false;
        _decided = approve;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Render the summary immediately, upgrade to the full record when it
    // lands. An approver staring at a spinner is an approver who taps back.
    final detail = ref.watch(approvalDetailProvider(widget.approval.id));
    final a = detail.maybeWhen(
      data: (full) => full,
      orElse: () => widget.approval,
    );

    if (_decided != null) return _confirmation(a);

    final currency = a.currency ?? 'PKR';

    return AppScaffold(
      header: AppHeader(
        title: 'Approvals',
        subtitle: a.canDecide ? 'Admin — full detail review' : 'Your request',
        trailing: StatusPill(
          label: a.canDecide ? 'Admin' : 'Read only',
          tone: a.canDecide ? PillTone.info : PillTone.neutral,
          showDot: false,
        ),
      ),
      footer: a.canDecide
          ? Row(
              children: [
                Expanded(
                  child: DangerButton(
                    label: 'Reject',
                    onPressed: _busy ? null : () => _decide(false),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  flex: 2,
                  child: PrimaryButton(
                    label: 'Approve',
                    busy: _busy,
                    icon: Icons.check,
                    onPressed: _busy ? null : () => _decide(true),
                  ),
                ),
              ],
            )
          : null,
      child: ListView(
        padding: const EdgeInsets.only(bottom: 16),
        children: [
          // 12a's ice banner.
          _AwaitingBanner(approval: a),
          const SizedBox(height: 12),

          // 12a card 1 -- the line items, headed by the vendor.
          _LineItemsCard(
            approval: a,
            currency: currency,
            loading: detail.isLoading,
          ),
          const SizedBox(height: 12),

          // 12a card 2 -- budget usage meter.
          if (a.budgetUtilisation != null) ...[
            _BudgetUsageCard(approval: a, currency: currency),
            const SizedBox(height: 12),
          ],

          // 8a -- the agent's stated reason. Approving a decision whose
          // reasoning you cannot see is the thing this screen exists to stop.
          if (a.justification != null && a.justification!.isNotEmpty) ...[
            GlassCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(
                        Icons.auto_awesome,
                        size: 15,
                        color: AppColors.turquoise,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        "Agent's justification",
                        style: AppText.sectionTitle(),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(a.justification!, style: AppText.explain()),
                ],
              ),
            ),
            const SizedBox(height: 12),
          ],

          // 12a's button pair.
          Row(
            children: [
              Expanded(child: PdfButton(pdfUrl: a.pdfUrl, expanded: false)),
              const SizedBox(width: 10),
              Expanded(
                child: SecondaryButton(
                  label: 'Audit trail',
                  icon: Icons.schedule_outlined,
                  height: 44,
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => AuditScreen(workflowId: a.workflowId),
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),

          GlassCard(
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => WorkflowDetailScreen(workflowId: a.workflowId),
              ),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Row(
              children: [
                const Icon(
                  Icons.account_tree_outlined,
                  size: 18,
                  color: AppColors.turquoise,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Review the full run, comparison and validation',
                    style: AppText.caption(AppColors.ink),
                  ),
                ),
                const Icon(
                  Icons.chevron_right,
                  size: 18,
                  color: AppColors.subtle,
                ),
              ],
            ),
          ),

          if (a.canDecide) ...[
            const SizedBox(height: 12),
            GlassCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Comment (optional)', style: AppText.listTitle()),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _comment,
                    maxLines: 3,
                    decoration: const InputDecoration(
                      hintText: 'Recorded against your decision…',
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            const InfoBanner(
              message:
                  'The agent cannot approve spend. This decision is what '
                  'releases the paused workflow, and it is recorded against '
                  'your account.',
              tone: PillTone.info,
              icon: Icons.shield_outlined,
            ),
          ] else ...[
            const SizedBox(height: 12),
            const InfoBanner(
              title: 'Waiting on an administrator',
              message:
                  'You raised this request, so you can follow it here — but '
                  'you cannot approve your own spend. An admin has to sign off.',
              tone: PillTone.warning,
              icon: Icons.lock_outline,
            ),
          ],
        ],
      ),
    );
  }

  /// Screen 8b.
  Widget _confirmation(Approval a) => AppScaffold(
    header: const AppHeader(title: 'Decision recorded'),
    footer: PrimaryButton(
      label: 'Back to queue',
      onPressed: () => Navigator.of(context).pop(),
    ),
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 72,
            height: 72,
            decoration: BoxDecoration(
              color: _decided! ? AppColors.successBg : AppColors.dangerBg,
              shape: BoxShape.circle,
            ),
            child: Icon(
              _decided! ? Icons.check_rounded : Icons.close_rounded,
              size: 36,
              color: _decided! ? AppColors.successFg : AppColors.dangerFg,
            ),
          ),
          const SizedBox(height: 18),
          Text(_decided! ? 'Approved' : 'Rejected', style: AppText.pageTitle()),
          const SizedBox(height: 6),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Text(
              _decided!
                  ? 'The workflow has resumed from where it paused. The '
                        'requester and the supplier have both been notified.'
                  : 'The workflow was stopped. No spend was committed, and '
                        'the requester has been notified.',
              textAlign: TextAlign.center,
              style: AppText.caption(),
            ),
          ),
          if (_decided! && a.pdfUrl != null) ...[
            const SizedBox(height: 20),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: PdfButton(pdfUrl: a.pdfUrl, label: 'View the PO'),
            ),
          ],
        ],
      ),
    ),
  );
}

/// 12a's banner: what is waiting, who raised it, and who may clear it.
class _AwaitingBanner extends StatelessWidget {
  const _AwaitingBanner({required this.approval});

  final Approval approval;

  @override
  Widget build(BuildContext context) {
    final who = approval.requesterName;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: AppColors.ice,
        border: Border.all(color: AppColors.glacier),
        borderRadius: BorderRadius.circular(AppRadii.banner),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${approval.poNumber ?? approval.title} awaiting approval',
            style: AppText.listTitle(),
          ),
          const SizedBox(height: 4),
          Text(
            [
              if (who != null) 'Requested by $who',
              'Staff cannot approve — admin sign-off required.',
            ].join(' · '),
            style: AppText.caption(),
          ),
        ],
      ),
    );
  }
}

/// 12a card 1 -- every line of the order, headed by the supplier.
class _LineItemsCard extends StatelessWidget {
  const _LineItemsCard({
    required this.approval,
    required this.currency,
    required this.loading,
  });

  final Approval approval;
  final String currency;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final items = approval.lineItems;

    return GlassCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    approval.vendorName != null
                        ? 'Line items — ${approval.vendorName}'
                        : 'Line items',
                    style: AppText.sectionTitle(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                Text(
                  items.isEmpty && loading
                      ? 'loading…'
                      : '${items.length} item${items.length == 1 ? '' : 's'}',
                  style: AppText.meta(),
                ),
              ],
            ),
          ),
          const HairLine(),
          if (items.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
              child: loading
                  ? const SkeletonBox(height: 44, radius: AppRadii.chip)
                  : Text(
                      'This approval has no purchase order attached.',
                      style: AppText.meta(),
                    ),
            )
          else
            for (final (i, li) in items.indexed) ...[
              if (i > 0) const HairLine(),
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            li.description,
                            style: AppText.listTitleSm(),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          formatMoney(li.lineTotal, currency),
                          style: AppText.captionStrong(AppColors.ink),
                        ),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(
                      [
                        if (li.sku != null && li.sku!.isNotEmpty) li.sku!,
                        '${li.quantity} × ${formatMoney(li.unitPrice, currency)}',
                      ].join(' · '),
                      style: AppText.meta(),
                    ),
                  ],
                ),
              ),
            ],
          const HairLine(),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(child: Text('GRAND TOTAL', style: AppText.micro())),
                Text(
                  formatMoney(approval.totalAmount, currency),
                  style: AppText.sectionTitle(AppColors.turquoise),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 12a card 2 -- "PKR 11.31M of 12M · 94%" over a filled meter.
class _BudgetUsageCard extends StatelessWidget {
  const _BudgetUsageCard({required this.approval, required this.currency});

  final Approval approval;
  final String currency;

  @override
  Widget build(BuildContext context) {
    final pct = approval.budgetUtilisation!;
    // Over budget should never reach a human as "fine" -- the agent excludes
    // over-budget vendors, so this is a last visual check, not the control.
    final tone = pct > 100
        ? AppColors.dangerFg
        : pct > 95
        ? AppColors.warningFg
        : AppColors.successFg;

    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text('Budget usage', style: AppText.sectionTitle()),
              ),
              Text('$pct%', style: AppText.captionStrong(tone)),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            '${formatMoney(approval.totalAmount, currency)} of '
            '${formatMoney(approval.budget, currency)}',
            style: AppText.caption(),
          ),
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: BorderRadius.circular(AppRadii.pill),
            child: LinearProgressIndicator(
              value: (pct / 100).clamp(0, 1),
              minHeight: 8,
              backgroundColor: AppColors.divider,
              valueColor: AlwaysStoppedAnimation(tone),
            ),
          ),
        ],
      ),
    );
  }
}

// ===========================================================================
// Screen 18a -- vendor management
// ===========================================================================
class VendorManagementScreen extends ConsumerWidget {
  const VendorManagementScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final vendors = ref.watch(vendorListProvider(null));

    return AppScaffold(
      header: const AppHeader(
        title: 'Vendor Management',
        subtitle: 'Verify, suspend, reinstate',
      ),
      child: vendors.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(message: '$e'),
        data: (page) => ListView.separated(
          padding: const EdgeInsets.only(bottom: 24),
          itemCount: page.items.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (_, i) => _ManageCard(vendor: page.items[i]),
        ),
      ),
    );
  }
}

class _ManageCard extends ConsumerWidget {
  const _ManageCard({required this.vendor});

  final Vendor vendor;

  Future<void> _setStatus(
    BuildContext context,
    WidgetRef ref,
    VendorStatus status,
  ) async {
    try {
      await ref
          .read(apiClientProvider)
          .setVendorStatus(vendor.id, status: status);
      ref.invalidate(vendorListProvider(null));
      ref.invalidate(dashboardProvider);
      if (context.mounted) {
        showToast(context, '${vendor.name} is now ${status.label}');
      }
    } on ApiException catch (e) {
      if (context.mounted) showToast(context, e.message, danger: true);
    }
  }

  /// The backend refuses to hard-delete a vendor that has quotes on record --
  /// the audit trail would lose the counterparty -- and returns 409 saying so.
  /// The dialog says it up front rather than letting the user find out by
  /// being refused.
  Future<void> _confirmDelete(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.white,
        title: Text('Delete ${vendor.name}?', style: AppText.sectionTitle()),
        content: Text(
          'This removes the vendor and its catalog entirely. A vendor that '
          'has ever been quoted cannot be deleted, because the audit trail '
          'would lose who was quoted -- suspend it instead.',
          style: AppText.body(),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(
              'Cancel',
              style: AppText.captionStrong(AppColors.muted),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(
              'Delete',
              style: AppText.captionStrong(AppColors.dangerFg),
            ),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    try {
      await ref.read(apiClientProvider).deleteVendor(vendor.id);
      ref.invalidate(vendorListProvider(null));
      ref.invalidate(dashboardProvider);
      if (context.mounted) showToast(context, '${vendor.name} deleted');
    } on ApiException catch (e) {
      if (context.mounted) showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) => GlassCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text(vendor.name, style: AppText.sectionTitle())),
            StatusPill.forVendor(vendor.status),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            if (vendor.reliability.hasHistory) ...[
              const Icon(
                Icons.star_rounded,
                size: 13,
                color: AppColors.warningFg,
              ),
              const SizedBox(width: 3),
              Text(
                '${vendor.reliability.display} · '
                '${vendor.reliability.ordersFulfilled} orders',
                style: AppText.meta(),
              ),
            ] else
              Text('No history yet', style: AppText.meta()),
            const Spacer(),
            if (vendor.reliability.onTimeRate != null)
              Text(
                '${(vendor.reliability.onTimeRate! * 100).round()}% on time',
                style: AppText.meta(),
              ),
          ],
        ),
        // The design's "2 late deliveries · flagged by agent".
        if (vendor.isFlagged) ...[
          const SizedBox(height: 10),
          for (final f in vendor.flags)
            InfoBanner(
              message: f.detail,
              tone: PillTone.danger,
              icon: Icons.flag,
            ),
        ],
        const SizedBox(height: 12),
        Row(
          children: [
            if (vendor.status != VendorStatus.verified)
              Expanded(
                child: SecondaryButton(
                  label: 'Verify',
                  height: 40,
                  icon: Icons.verified_outlined,
                  onPressed: () =>
                      _setStatus(context, ref, VendorStatus.verified),
                ),
              ),
            if (vendor.status != VendorStatus.verified)
              const SizedBox(width: 8),
            Expanded(
              child: vendor.status == VendorStatus.suspended
                  ? SecondaryButton(
                      label: 'Reinstate',
                      height: 40,
                      icon: Icons.restart_alt,
                      onPressed: () =>
                          _setStatus(context, ref, VendorStatus.verified),
                    )
                  : DangerButton(
                      label: 'Suspend',
                      height: 40,
                      onPressed: () =>
                          _setStatus(context, ref, VendorStatus.suspended),
                    ),
            ),
            // Delete sits behind the overflow rather than beside Suspend.
            // Suspending is reversible and is what an admin almost always
            // wants; the two should not look like equivalent choices.
            const SizedBox(width: 4),
            _VendorOverflow(
              onDelete: () => _confirmDelete(context, ref),
              onOpen: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => VendorDetailScreen(vendorId: vendor.id),
                ),
              ),
            ),
          ],
        ),
      ],
    ),
  );
}

class _VendorOverflow extends StatelessWidget {
  const _VendorOverflow({required this.onDelete, required this.onOpen});

  final VoidCallback onDelete;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) => PopupMenuButton<String>(
    icon: const Icon(Icons.more_vert, size: 20, color: AppColors.subtle),
    color: AppColors.white,
    position: PopupMenuPosition.under,
    onSelected: (value) {
      HapticFeedback.selectionClick();
      if (value == 'delete') {
        onDelete();
      } else {
        onOpen();
      }
    },
    itemBuilder: (_) => [
      PopupMenuItem(
        value: 'open',
        child: Text('View details', style: AppText.body()),
      ),
      PopupMenuItem(
        value: 'delete',
        child: Text('Delete vendor', style: AppText.body(AppColors.dangerFg)),
      ),
    ],
  );
}
