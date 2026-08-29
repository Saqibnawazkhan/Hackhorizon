/// Screen 10a -- Workflow history, filterable.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/models.dart';
import '../../state/providers.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../widgets/workflow_widgets.dart';
import 'workflow_detail_screen.dart';
import '../../state/cached.dart';

class HistoryScreen extends ConsumerStatefulWidget {
  const HistoryScreen({super.key, this.embedded = false});

  /// True when hosted inside the tab shell (no back chevron).
  final bool embedded;

  @override
  ConsumerState<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends ConsumerState<HistoryScreen> {
  String? _status;
  String? _type;

  static const _statusFilters = <String, String>{
    'running': 'In Progress',
    'awaiting_approval': 'Pending',
    'completed': 'Done',
    'escalated': 'Needs Attention',
  };

  @override
  Widget build(BuildContext context) {
    final filter = WorkflowFilter(status: _status, workflowType: _type);
    final workflows = ref.watch(workflowListProvider(filter));

    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // -- filter chips -------------------------------------------
        SizedBox(
          height: 34,
          child: ListView(
            scrollDirection: Axis.horizontal,
            children: [
              FilterChipButton(
                label: 'All',
                selected: _status == null && _type == null,
                onTap: () => setState(() {
                  _status = null;
                  _type = null;
                }),
              ),
              const SizedBox(width: 8),
              for (final e in _statusFilters.entries) ...[
                FilterChipButton(
                  label: e.value,
                  selected: _status == e.key,
                  onTap: () => setState(
                    () => _status = _status == e.key ? null : e.key,
                  ),
                ),
                const SizedBox(width: 8),
              ],
              FilterChipButton(
                label: 'Procurement',
                selected: _type == 'procurement',
                onTap: () => setState(
                  () => _type = _type == 'procurement' ? null : 'procurement',
                ),
              ),
              const SizedBox(width: 8),
              FilterChipButton(
                label: 'Reimbursement',
                selected: _type == 'reimbursement',
                onTap: () => setState(
                  () =>
                      _type = _type == 'reimbursement' ? null : 'reimbursement',
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Expanded(
          child: workflows.cachedWhen(
            loading: () => ListView(
              children: const [
                SkeletonBox(height: 62, radius: 20),
                SizedBox(height: 8),
                SkeletonBox(height: 62, radius: 20),
                SizedBox(height: 8),
                SkeletonBox(height: 62, radius: 20),
              ],
            ),
            error: (e, _) => ErrorState(
              message: '$e',
              onRetry: () => ref.invalidate(workflowListProvider(filter)),
            ),
            data: (page) {
              if (page.items.isEmpty) {
                return const EmptyState(
                  title: 'Nothing here',
                  message: 'No workflows match these filters.',
                  icon: Icons.filter_list_off,
                );
              }
              return RefreshIndicator(
                color: AppColors.turquoise,
                onRefresh: () async =>
                    ref.refresh(workflowListProvider(filter).future),
                child: ListPanelList(
                  items: page.items,
                  onTap: (w) => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => WorkflowDetailScreen(workflowId: w.id),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );

    if (widget.embedded) return body;

    return AppScaffold(
      header: AppHeader(
        title: 'Workflow History',
        subtitle: workflows.valueOrNull == null
            ? null
            : '${workflows.value!.total} total',
      ),
      child: body,
    );
  }
}

/// The history list, grouped into one glass panel per day-ish chunk. Kept
/// separate so both the tab and the standalone screen share it.
class ListPanelList extends StatelessWidget {
  const ListPanelList({super.key, required this.items, required this.onTap});

  final List<WorkflowSummary> items;
  final ValueChanged<WorkflowSummary> onTap;

  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          ListPanel(
            children: [
              for (var i = 0; i < items.length; i++)
                WorkflowTile(
                  workflow: items[i],
                  showDivider: i < items.length - 1,
                  onTap: () => onTap(items[i]),
                ),
            ],
          ),
        ],
      );
}
