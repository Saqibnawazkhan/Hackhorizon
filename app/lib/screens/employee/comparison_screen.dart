/// Screens 5a and 11a -- supplier comparison.
///
/// One screen serves both: when the request has a single line item it renders
/// 5a's layout (metadata grid plus the stacked score bars); when it has
/// several it renders 11a's (a chip row, per-line breakdowns, coverage
/// labels). The backend already decided which scoring strategy ran, so the UI
/// follows the data rather than a flag.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/models.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../widgets/workflow_widgets.dart';
import '../../state/cached.dart';

class ComparisonScreen extends ConsumerWidget {
  const ComparisonScreen({super.key, required this.workflowId});

  final String workflowId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final quotes = ref.watch(comparisonProvider(workflowId));
    final detail = ref.watch(workflowDetailProvider(workflowId));

    return AppScaffold(
      header: AppHeader(
        title: 'Supplier Comparison',
        subtitle: quotes.valueOrNull == null
            ? null
            : _subtitle(quotes.value!, detail.valueOrNull),
      ),
      child: quotes.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(comparisonProvider(workflowId)),
        ),
        data: (list) {
          if (list.isEmpty) {
            return const EmptyState(
              title: 'No quotes yet',
              message: 'The agent has not reached the quoting step.',
              icon: Icons.compare_arrows,
            );
          }

          final multi = list.first.itemsRequested > 1;
          final scored = list.where((q) => q.scoreTotal != null).toList();
          final selected =
              list.where((q) => q.isSelected).firstOrNull;
          final entities = detail.valueOrNull?.entities;

          return ListView(
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              // -- 11a: the requested line items as chips ---------------
              if (multi && entities != null) ...[
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final i in entities.items)
                      EntityChip(label: i.chipLabel),
                  ],
                ),
                const SizedBox(height: 12),
              ],

              // -- supplier cards, ranked --------------------------------
              for (final q in list) ...[
                VendorQuoteCard(quote: q, showLines: multi),
                const SizedBox(height: 10),
              ],

              // -- the scoring panel (5a) -------------------------------
              if (scored.isNotEmpty) ...[
                const SizedBox(height: 2),
                GlassCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.baseline,
                        textBaseline: TextBaseline.alphabetic,
                        children: [
                          Expanded(
                            child: Text('Scoring', style: AppText.sectionTitle()),
                          ),
                          Text(
                            _weightsLabel(scored.first),
                            style: AppText.meta(),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      for (final q in list)
                        ScoreBreakdownBar(
                          label: _shortName(q.vendorName),
                          components: q.components,
                          total: q.scoreTotal,
                          dimmed: q.status.isExcluded,
                          excludedLabel:
                              q.status.isExcluded ? '—' : null,
                        ),
                      const SizedBox(height: 2),
                      ScoreLegend(
                        criteria: scored.first.components
                            .map((c) => c.criterion)
                            .toList(),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
              ],

              // -- the agent's justification ----------------------------
              if (selected != null)
                InfoBanner(
                  title: 'Selected ${selected.vendorName}',
                  message: _justification(selected, list, multi),
                  tone: PillTone.success,
                  icon: Icons.check_circle_outline,
                ),

              // -- caveats the human must see ---------------------------
              for (final q in list.where(
                (q) => q.isSelected && !q.reliabilityHasHistory,
              )) ...[
                const SizedBox(height: 10),
                InfoBanner(
                  message:
                      '${q.vendorName} is a new vendor with no fulfilment '
                      'history. It was scored neutrally on reliability — '
                      'worth a look before you approve.',
                  tone: PillTone.warning,
                  icon: Icons.info_outline,
                ),
              ],
            ],
          );
        },
      ),
    );
  }

  String _subtitle(List<Quote> quotes, WorkflowDetail? detail) {
    if (quotes.isEmpty) return '';
    final multi = quotes.first.itemsRequested > 1;
    if (multi) {
      final budget = detail?.budget;
      return 'Mixed order · ${quotes.first.itemsRequested} line items'
          '${budget != null ? ' · budget ${formatMoney(budget, quotes.first.currency)}' : ''}';
    }
    return 'Step 4 · Score & rank suppliers';
  }

  /// Rebuild the design's weights label from the score components, so it
  /// always reflects the weights that actually ran.
  String _weightsLabel(Quote q) => q.components
      .map((c) =>
          '${c.criterion[0].toUpperCase()}${c.criterion.substring(1)} '
          '${(c.weight * 100).round()}%')
      .join(' · ');

  String _shortName(String name) {
    const drop = [' Ltd', ' Limited', ' Computers', ' Traders', ' Imports'];
    for (final d in drop) {
      if (name.endsWith(d)) return name.substring(0, name.length - d.length);
    }
    return name;
  }

  /// A deterministic sentence, so a decision is never shown unexplained even
  /// if the narrator call failed.
  String _justification(Quote winner, List<Quote> all, bool multi) {
    final parts = <String>[];
    if (multi) {
      final others = all.where((q) => !q.isSelected && q.isPartial).length;
      parts.add(
        'only in-budget supplier covering all ${winner.itemsRequested} line '
        'items in one purchase order',
      );
      if (others > 0) {
        parts.add('$others other supplier(s) could not cover the full order');
      }
    } else {
      parts.add('lowest qualifying total');
    }
    parts.add('${formatMoney(winner.totalAmount, winner.currency)} total');
    if (winner.deliveryDays != null) {
      parts.add('${winner.deliveryDays}-day delivery');
    }
    if (winner.warrantyMonths != null) {
      parts.add('${formatWarranty(winner.warrantyMonths)} warranty');
    }
    return '${parts.join(', ')}.';
  }
}

extension<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
