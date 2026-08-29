/// Screens 6a and 6b -- validation results.
///
/// 6a: every check passed.
/// 6b: a check failed, and the agent is rebuilding the PO to fix it.
///
/// Both come from the same report; which one you see depends on `passed` and
/// how many self-correction attempts remain.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../widgets/workflow_widgets.dart';
import '../../state/cached.dart';

class ValidationScreen extends ConsumerWidget {
  const ValidationScreen({super.key, required this.workflowId});

  final String workflowId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final report = ref.watch(validationProvider(workflowId));

    return AppScaffold(
      header: AppHeader(
        title: 'Validation Results',
        subtitle: report.valueOrNull == null
            ? null
            : 'Step 7 · ${report.value!.summaryLabel}',
        trailing: report.valueOrNull == null
            ? null
            : StatusPill(
                label: report.value!.passed ? 'Passed' : 'Failed',
                tone: report.value!.passed
                    ? PillTone.success
                    : PillTone.danger,
              ),
      ),
      child: report.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(validationProvider(workflowId)),
        ),
        data: (r) => ListView(
          padding: const EdgeInsets.only(bottom: 24),
          children: [
            // -- headline ------------------------------------------------
            GlassCard(
              child: Row(
                children: [
                  Container(
                    width: 46,
                    height: 46,
                    decoration: BoxDecoration(
                      color: r.passed
                          ? AppColors.successBg
                          : AppColors.dangerBg,
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      r.passed ? Icons.verified : Icons.report_problem,
                      color: r.passed
                          ? AppColors.successFg
                          : AppColors.dangerFg,
                      size: 22,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(r.summaryLabel, style: AppText.sectionTitle()),
                        const SizedBox(height: 2),
                        Text(
                          r.passed
                              ? 'The purchase order is consistent with the '
                                  'quote it was priced from.'
                              : 'The agent found problems with its own output.',
                          style: AppText.caption(),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),

            // -- 6b: the self-correction banner -------------------------
            if (!r.passed) ...[
              const SizedBox(height: 12),
              InfoBanner(
                title: r.canSelfCorrect
                    ? 'Self-correcting'
                    : 'Escalated to a human',
                message: r.canSelfCorrect
                    ? 'Attempt ${r.attempt} of ${r.maxAttempts} failed. The '
                        'agent is regenerating the purchase order to fix '
                        '${r.failures.length} issue(s).'
                    : 'The agent exhausted its ${r.maxAttempts} correction '
                        'attempts and stopped rather than proceeding with an '
                        'invalid order.',
                tone: r.canSelfCorrect ? PillTone.warning : PillTone.danger,
                icon: r.canSelfCorrect
                    ? Icons.autorenew
                    : Icons.pan_tool_outlined,
              ),
            ],

            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: Text('Checks', style: AppText.captionStrong(AppColors.muted)),
                ),
                Text(
                  'Attempt ${r.attempt} of ${r.maxAttempts}',
                  style: AppText.meta(),
                ),
              ],
            ),
            const SizedBox(height: 8),

            for (final c in r.checks) ValidationCheckRow(check: c),

            const SizedBox(height: 8),
            Text(
              'These checks are deterministic code, not a model judgement. '
              'Each compares the purchase order against the supplier quote '
              'snapshot taken at comparison time.',
              style: AppText.meta(),
            ),
          ],
        ),
      ),
    );
  }
}
