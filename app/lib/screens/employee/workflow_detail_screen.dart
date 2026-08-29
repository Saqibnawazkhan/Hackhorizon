/// Screens 4a / 4b -- live execution, and the gateway to every artefact the
/// run produces.
///
/// 4a: the stepper with the active step's tool log expanded.
/// 4b: a failed step showing its auto-retry state.
///
/// The stepper is driven by the WebSocket when it is available and by polling
/// when it is not; the connection state is shown rather than hidden, because
/// "is this stuck or is my socket dead" is a real question a user will ask.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/models.dart';
import '../../state/live_workflow.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../widgets/workflow_widgets.dart';
import 'audit_screen.dart';
import 'comparison_screen.dart';
import 'po_screen.dart';
import 'report_screen.dart';
import 'validation_screen.dart';
import '../../widgets/quote_request_card.dart';

class WorkflowDetailScreen extends ConsumerStatefulWidget {
  const WorkflowDetailScreen({
    super.key,
    required this.workflowId,
    this.live = false,
  });

  final String workflowId;

  /// True when arriving straight from "Confirm & Execute".
  final bool live;

  @override
  ConsumerState<WorkflowDetailScreen> createState() =>
      _WorkflowDetailScreenState();
}

class _WorkflowDetailScreenState extends ConsumerState<WorkflowDetailScreen> {
  String? _expandedStepId;
  WorkflowStatus? _lastStatus;

  @override
  Widget build(BuildContext context) {
    final live = ref.watch(liveWorkflowProvider(widget.workflowId));
    final detail = live.detail;

    // Haptics per the brief: light on completion, heavy on failure.
    if (detail != null && detail.status != _lastStatus) {
      final previous = _lastStatus;
      _lastStatus = detail.status;
      if (previous != null) {
        if (detail.status == WorkflowStatus.completed) {
          HapticFeedback.lightImpact();
        } else if (detail.status == WorkflowStatus.failed ||
            detail.status == WorkflowStatus.escalated) {
          HapticFeedback.heavyImpact();
        }
      }
    }

    if (detail == null) {
      return const AppScaffold(
        header: AppHeader(title: 'Workflow'),
        child: LoadingState(label: 'Loading workflow…'),
      );
    }

    final active = detail.activeStep;
    final expandedId = _expandedStepId ?? active?.id;
    final isProcurement = detail.workflowType == 'procurement';

    return AppScaffold(
      header: AppHeader(
        title: detail.title,
        subtitle: _subtitle(detail, live.connection),
        trailing: StatusPill.forWorkflow(detail.status),
      ),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          // -- progress ------------------------------------------------
          GlassCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Execution',
                        style: AppText.sectionTitle(),
                      ),
                    ),
                    Text(
                      '${detail.progressPercent}%',
                      style: AppText.captionStrong(AppColors.turquoise),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                ClipRRect(
                  borderRadius: BorderRadius.circular(AppRadii.pill),
                  child: LinearProgressIndicator(
                    value: detail.progressPercent / 100,
                    minHeight: 6,
                    backgroundColor: AppColors.divider,
                    valueColor: const AlwaysStoppedAnimation(
                      AppColors.turquoise,
                    ),
                  ),
                ),
                const SizedBox(height: 14),
                for (var i = 0; i < detail.steps.length; i++)
                  StepRow(
                    step: detail.steps[i],
                    isLast: i == detail.steps.length - 1,
                    expanded: detail.steps[i].id == expandedId,
                    onTap: () => setState(
                      () => _expandedStepId =
                          _expandedStepId == detail.steps[i].id
                              ? ''
                              : detail.steps[i].id,
                    ),
                  ),
              ],
            ),
          ),

          // -- escalation (the budget branch, or self-correction exhausted)
          if (detail.escalationReason != null) ...[
            const SizedBox(height: 12),
            InfoBanner(
              title: 'Needs a human',
              message: detail.escalationReason!,
              tone: PillTone.danger,
              icon: Icons.report_problem_outlined,
            ),
            // "Needs a human" used to be the end of the road. Where the
            // reason is that nothing in the catalog matched, there is a way
            // forward: ask the suppliers to list it.
            const SizedBox(height: 12),
            QuoteRequestCard(
              workflowId: detail.id,
              escalationReason: detail.escalationReason!,
            ),
          ],

          if (detail.status == WorkflowStatus.awaitingApproval) ...[
            const SizedBox(height: 12),
            const InfoBanner(
              title: 'Awaiting approval',
              message:
                  'The agent has paused here. It cannot approve spend itself — '
                  'an administrator must decide before this proceeds.',
              tone: PillTone.warning,
              icon: Icons.pan_tool_outlined,
            ),
          ],

          const SizedBox(height: 16),
          Text('Artefacts', style: AppText.captionStrong(AppColors.muted)),
          const SizedBox(height: 8),

          // Only offer artefacts this workflow type actually produces. A
          // reimbursement has no supplier comparison and no purchase order,
          // and linking to them would just 404.
          if (isProcurement) ...[
            _link(
              icon: Icons.compare_arrows,
              title: 'Supplier comparison',
              subtitle: 'Scoring, coverage and the decision',
              onTap: () => _push(ComparisonScreen(workflowId: detail.id)),
            ),
            _link(
              icon: Icons.fact_check_outlined,
              title: 'Validation results',
              subtitle: 'Budget, quantities, supplier consistency',
              onTap: () => _push(ValidationScreen(workflowId: detail.id)),
            ),
            _link(
              icon: Icons.description_outlined,
              title: 'Purchase order',
              subtitle: 'The generated PO and its PDF',
              onTap: () => _push(PurchaseOrderScreen(workflowId: detail.id)),
            ),
          ],
          _link(
            icon: Icons.summarize_outlined,
            title: 'Completion report',
            subtitle: 'Plain-language summary',
            onTap: () => _push(ReportScreen(workflowId: detail.id)),
          ),
          _link(
            icon: Icons.history,
            title: 'Audit trail',
            subtitle: 'Every step and tool call, timestamped',
            onTap: () => _push(AuditScreen(workflowId: detail.id)),
          ),
        ],
      ),
    );
  }

  void _push(Widget screen) => Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => screen),
      );

  String _subtitle(WorkflowDetail d, LiveConnection c) {
    final active = d.activeStep;
    if (active != null) {
      return 'Step ${active.order} of ${d.steps.length} · ${active.title}'
          '${c == LiveConnection.polling ? ' · polling' : ''}';
    }
    if (d.durationMs != null) {
      return 'Finished in ${formatDuration(d.durationMs)}';
    }
    return '${d.steps.length} steps';
  }

  Widget _link({
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
  }) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: GlassCard(
          onTap: onTap,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: AppColors.ice,
                  borderRadius: BorderRadius.circular(AppRadii.field),
                ),
                child: Icon(icon, size: 17, color: AppColors.turquoise),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: AppText.listTitle()),
                    Text(subtitle, style: AppText.meta()),
                  ],
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
      );
}
