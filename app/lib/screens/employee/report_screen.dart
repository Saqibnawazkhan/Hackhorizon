/// Screen 9a -- Completion report.
///
/// A plain-language summary assembled from the execution trace, not
/// regenerated prose: every number here was produced by the run.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../state/cached.dart';

class ReportScreen extends ConsumerWidget {
  const ReportScreen({super.key, required this.workflowId});

  final String workflowId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final report = ref.watch(reportProvider(workflowId));

    return AppScaffold(
      header: const AppHeader(
        title: 'Completion Report',
        subtitle: 'Executive summary',
      ),
      child: report.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(reportProvider(workflowId)),
        ),
        data: (r) => ListView(
          padding: const EdgeInsets.only(bottom: 24),
          children: [
            GlassCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 40,
                        height: 40,
                        decoration: const BoxDecoration(
                          color: AppColors.successBg,
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(
                          Icons.task_alt,
                          color: AppColors.successFg,
                          size: 20,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(r.headline, style: AppText.sectionTitle()),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      for (final m in r.metrics)
                        SizedBox(
                          width: 150,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(m.label, style: AppText.micro()),
                              const SizedBox(height: 2),
                              Text(
                                m.value,
                                style: m.emphasis
                                    ? AppText.sectionTitle(AppColors.turquoise)
                                    : AppText.listTitle(),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),

            for (final s in r.sections) ...[
              GlassCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s.heading, style: AppText.sectionTitle()),
                    const SizedBox(height: 6),
                    Text(s.body, style: AppText.body(AppColors.bubbleText)),
                    if (s.bullets.isNotEmpty) ...[
                      const SizedBox(height: 10),
                      for (final b in s.bullets)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 5),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Container(
                                width: 5,
                                height: 5,
                                margin: const EdgeInsets.only(top: 6, right: 8),
                                decoration: const BoxDecoration(
                                  color: AppColors.glacier,
                                  shape: BoxShape.circle,
                                ),
                              ),
                              Expanded(
                                child: Text(b, style: AppText.caption()),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 12),
            ],

            // -- every autonomous decision, with its justification --------
            if (r.decisions.isNotEmpty) ...[
              GlassCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Decisions taken', style: AppText.sectionTitle()),
                    const SizedBox(height: 8),
                    for (final d in r.decisions)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Icon(
                              Icons.check_circle_outline,
                              size: 14,
                              color: AppColors.successFg,
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(d, style: AppText.caption()),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
            ],

            if (r.caveats.isNotEmpty)
              InfoBanner(
                title: 'Worth knowing',
                message: r.caveats.join('\n'),
                tone: PillTone.warning,
                icon: Icons.info_outline,
              ),

            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _stat('${r.stepsExecuted}', 'steps'),
                ),
                Expanded(child: _stat('${r.toolsInvoked}', 'tool calls')),
                Expanded(child: _stat('${r.retriesPerformed}', 'retries')),
                Expanded(
                  child: _stat(formatDuration(r.totalDurationMs), 'duration'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _stat(String value, String label) => Column(
        children: [
          Text(value, style: AppText.sectionTitle(AppColors.turquoise)),
          const SizedBox(height: 2),
          Text(label, style: AppText.micro()),
        ],
      );
}
