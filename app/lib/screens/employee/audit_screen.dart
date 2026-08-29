/// Screen 10b -- Audit trail.
///
/// A union over steps, tool calls and approvals rather than a separate log
/// table, so the trail can never disagree with what actually executed.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/providers.dart';
import '../../theme/surfaces.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../widgets/workflow_widgets.dart';
import '../../state/cached.dart';

class AuditScreen extends ConsumerWidget {
  const AuditScreen({super.key, required this.workflowId});

  final String workflowId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(auditProvider(workflowId));

    return AppScaffold(
      header: AppHeader(
        title: 'Audit Trail',
        subtitle: events.valueOrNull == null
            ? null
            : '${events.value!.length} events, timestamped',
      ),
      child: events.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(auditProvider(workflowId)),
        ),
        data: (list) {
          if (list.isEmpty) {
            return const EmptyState(
              title: 'Nothing recorded yet',
              icon: Icons.history,
            );
          }
          return ListView(
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              const InfoBanner(
                message:
                    'Every step and tool call is recorded as it happens, so '
                    'this remains retrievable long after the run finishes.',
                tone: PillTone.info,
                icon: Icons.verified_outlined,
              ),
              const SizedBox(height: 14),
              GlassCard(
                padding: const EdgeInsets.fromLTRB(14, 16, 14, 6),
                child: Column(
                  children: [
                    for (var i = 0; i < list.length; i++)
                      TimelineRow(
                        event: list[i],
                        isLast: i == list.length - 1,
                      ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
