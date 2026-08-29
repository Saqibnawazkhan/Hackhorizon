/// The admin surfaces behind screen 17a's "Quick actions".
///
///   ScoringWeightsScreen -- edit the weights every comparison is scored on
///   SpendReportScreen    -- spend and reliability by vendor
///   PolicyRulesScreen    -- the rules the reimbursement checker applies
///   FlaggedVendorsScreen -- what the performance monitor raised
///
/// Each of these had a working endpoint and nothing calling it. They are
/// separate screens rather than panels on the dashboard because each answers a
/// different question, and because a failure in one should not blank the rest.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../state/cached.dart';

// ===========================================================================
// Scoring weights -- editable
// ===========================================================================
class ScoringWeightsScreen extends ConsumerStatefulWidget {
  const ScoringWeightsScreen({super.key});

  @override
  ConsumerState<ScoringWeightsScreen> createState() =>
      _ScoringWeightsScreenState();
}

class _ScoringWeightsScreenState extends ConsumerState<ScoringWeightsScreen> {
  /// Percentage points, so the sliders move in units a person thinks in.
  int? _price;
  int? _delivery;
  int? _warranty;
  int? _reliability;
  bool _busy = false;

  void _seed(ScoringWeights w) {
    _price ??= (w.price * 100).round();
    _delivery ??= (w.delivery * 100).round();
    _warranty ??= (w.warranty * 100).round();
    _reliability ??= (w.reliability * 100).round();
  }

  int get _total =>
      (_price ?? 0) + (_delivery ?? 0) + (_warranty ?? 0) + (_reliability ?? 0);

  bool get _balanced => _total == 100;

  Future<void> _save() async {
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).setScoringWeights(
            ScoringWeights(
              price: _price! / 100,
              delivery: _delivery! / 100,
              warranty: _warranty! / 100,
              reliability: _reliability! / 100,
              label: '',
              isDefault: false,
            ),
          );
      ref.invalidate(scoringWeightsProvider);
      if (!mounted) return;
      setState(() => _busy = false);
      showToast(context, 'Weights saved — the next run uses them');
      Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final weights = ref.watch(scoringWeightsProvider);

    return AppScaffold(
      header: const AppHeader(
        title: 'Scoring weights',
        subtitle: 'How every comparison is decided',
      ),
      footer: weights.hasValue
          ? PrimaryButton(
              label: _balanced ? 'Save weights' : 'Must total 100% (now $_total%)',
              busy: _busy,
              onPressed: _balanced ? _save : null,
            )
          : null,
      child: weights.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(scoringWeightsProvider),
        ),
        data: (w) {
          _seed(w);
          return ListView(
            padding: const EdgeInsets.only(bottom: 16),
            children: [
              ClayCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            'These decide the outcome',
                            style: AppText.sectionTitle(),
                          ),
                        ),
                        if (w.isDefault)
                          const StatusPill(
                            label: 'Default',
                            tone: PillTone.neutral,
                            showDot: false,
                          ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Every supplier comparison is scored on these four. '
                      'Changing them changes which vendor the agent picks, '
                      'and takes effect on the next run — no redeploy.',
                      style: AppText.explain(),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              GlassCard(
                child: Column(
                  children: [
                    _WeightSlider(
                      label: 'Price',
                      hint: 'Lowest qualifying total wins',
                      value: _price!,
                      onChanged: (v) => setState(() => _price = v),
                    ),
                    _WeightSlider(
                      label: 'Delivery',
                      hint: 'Fewer days is better',
                      value: _delivery!,
                      onChanged: (v) => setState(() => _delivery = v),
                    ),
                    _WeightSlider(
                      label: 'Warranty',
                      hint: 'More months is better',
                      value: _warranty!,
                      onChanged: (v) => setState(() => _warranty = v),
                    ),
                    _WeightSlider(
                      label: 'Reliability',
                      hint: 'On-time rate from past orders',
                      value: _reliability!,
                      onChanged: (v) => setState(() => _reliability = v),
                      last: true,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              InfoBanner(
                title: _balanced
                    ? 'Totals 100%'
                    : 'Totals $_total% — adjust to 100%',
                message: _balanced
                    ? 'Scores stay comparable across runs.'
                    : 'Weights that do not sum to 100% would make scores from '
                        'different runs incomparable, so this is refused '
                        'rather than normalised behind your back.',
                tone: _balanced ? PillTone.success : PillTone.warning,
                icon: _balanced ? Icons.check_circle_outline : Icons.balance,
              ),
              const SizedBox(height: 12),
              MutedSurface(
                borderColor: AppColors.platinum,
                child: Text(
                  'Reliability is only applied to vendors with delivery '
                  'history. A new vendor is not penalised for having none.',
                  style: AppText.meta(),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _WeightSlider extends StatelessWidget {
  const _WeightSlider({
    required this.label,
    required this.hint,
    required this.value,
    required this.onChanged,
    this.last = false,
  });

  final String label;
  final String hint;
  final int value;
  final ValueChanged<int> onChanged;
  final bool last;

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.only(bottom: last ? 0 : 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(label, style: AppText.listTitleSm()),
                      const SizedBox(height: 1),
                      Text(hint, style: AppText.meta()),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.ice,
                    borderRadius: BorderRadius.circular(AppRadii.pill),
                  ),
                  child: Text(
                    '$value%',
                    style: AppText.captionStrong(AppColors.turquoise),
                  ),
                ),
              ],
            ),
            SliderTheme(
              data: SliderTheme.of(context).copyWith(
                activeTrackColor: AppColors.turquoise,
                inactiveTrackColor: AppColors.clayRecess,
                thumbColor: AppColors.turquoise,
                overlayColor: AppColors.turquoise.withValues(alpha: 0.12),
                trackHeight: 4,
              ),
              child: Slider(
                value: value.toDouble(),
                max: 100,
                divisions: 20, // 5% steps
                onChanged: (v) => onChanged(v.round()),
              ),
            ),
          ],
        ),
      );
}

// ===========================================================================
// Spend report
// ===========================================================================
class SpendReportScreen extends ConsumerStatefulWidget {
  const SpendReportScreen({super.key});

  @override
  ConsumerState<SpendReportScreen> createState() => _SpendReportScreenState();
}

class _SpendReportScreenState extends ConsumerState<SpendReportScreen> {
  int _days = 30;

  @override
  Widget build(BuildContext context) {
    final report = ref.watch(spendReportProvider(_days));

    return AppScaffold(
      header: const AppHeader(
        title: 'Spend & budget',
        subtitle: 'Approved purchase orders by vendor',
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              for (final days in const [7, 30, 90, 365])
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: FilterChipButton(
                    label: days == 365 ? '1 year' : '$days days',
                    selected: _days == days,
                    onTap: () => setState(() => _days = days),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 12),
          Expanded(
            child: report.cachedWhen(
              loading: () => const LoadingState(),
              error: (e, _) => ErrorState(
                message: '$e',
                onRetry: () => ref.invalidate(spendReportProvider(_days)),
              ),
              data: (data) => _SpendBody(data: data, days: _days),
            ),
          ),
        ],
      ),
    );
  }
}

class _SpendBody extends StatelessWidget {
  const _SpendBody({required this.data, required this.days});

  final Map<String, dynamic> data;
  final int days;

  @override
  Widget build(BuildContext context) {
    final currency = '${data['currency'] ?? 'PKR'}';
    final total = (data['total_spend'] as num?)?.toDouble() ?? 0;
    final orders = (data['order_count'] as num?)?.toInt() ?? 0;
    final vendors = ((data['by_vendor'] as List?) ?? const [])
        .map((e) => (e as Map).cast<String, dynamic>())
        .toList();

    if (vendors.isEmpty) {
      return EmptyState(
        icon: Icons.receipt_long_outlined,
        title: 'No spend in the last $days days',
        message: 'Approved purchase orders appear here once a run completes.',
      );
    }

    // Share-of-spend bars are drawn against the largest vendor, not the
    // total: with one dominant vendor every other bar would be invisible.
    final largest = vendors
        .map((v) => (v['total_spend'] as num?)?.toDouble() ?? 0)
        .fold<double>(0, (a, b) => a > b ? a : b);

    return ListView(
      padding: const EdgeInsets.only(bottom: 20),
      children: [
        Container(
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 18),
          decoration: BoxDecoration(
            gradient: AppGradients.hero,
            borderRadius: BorderRadius.circular(AppRadii.card),
            boxShadow: AppShadows.hero,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Last $days days',
                style: AppText.caption(const Color(0xFFA2A2AC)),
              ),
              const SizedBox(height: 3),
              Text(
                formatMoney(total, currency),
                style: AppText.hero(AppColors.white),
              ),
              const SizedBox(height: 4),
              Text(
                '$orders order${orders == 1 ? '' : 's'} across '
                '${vendors.length} vendor${vendors.length == 1 ? '' : 's'}',
                style: AppText.caption(const Color(0xFFD6EBF3)),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        const SectionHeader(title: 'By vendor'),
        const SizedBox(height: 8),
        for (final vendor in vendors)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: _SpendRow(
              vendor: vendor,
              currency: currency,
              largest: largest,
              total: total,
            ),
          ),
      ],
    );
  }
}

class _SpendRow extends StatelessWidget {
  const _SpendRow({
    required this.vendor,
    required this.currency,
    required this.largest,
    required this.total,
  });

  final Map<String, dynamic> vendor;
  final String currency;
  final double largest;
  final double total;

  @override
  Widget build(BuildContext context) {
    final spend = (vendor['total_spend'] as num?)?.toDouble() ?? 0;
    final orders = (vendor['order_count'] as num?)?.toInt() ?? 0;
    final onTime = (vendor['on_time_rate'] as num?)?.toDouble();
    final share = total > 0 ? spend / total : 0.0;
    final barFraction = largest > 0 ? spend / largest : 0.0;

    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${vendor['vendor_name']}',
                  style: AppText.listTitle(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Text(
                formatMoney(spend, currency),
                style: AppText.captionStrong(AppColors.ink),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(AppRadii.tiny),
            child: SizedBox(
              height: 6,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(
                    flex: (barFraction * 1000).round().clamp(1, 1000),
                    child: const ColoredBox(color: AppColors.turquoise),
                  ),
                  Expanded(
                    flex: ((1 - barFraction) * 1000).round().clamp(0, 1000),
                    child: const ColoredBox(color: AppColors.clayRecess),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Text(
                '${(share * 100).toStringAsFixed(share >= 0.1 ? 0 : 1)}% '
                'of spend · $orders order${orders == 1 ? '' : 's'}',
                style: AppText.meta(),
              ),
              const Spacer(),
              if (onTime != null)
                StatusPill(
                  label: '${(onTime * 100).round()}% on time',
                  tone: onTime >= 0.9
                      ? PillTone.success
                      : onTime >= 0.75
                          ? PillTone.warning
                          : PillTone.danger,
                  showDot: false,
                )
              else
                Text('No delivery history', style: AppText.meta()),
            ],
          ),
        ],
      ),
    );
  }
}

// ===========================================================================
// Policy rules
// ===========================================================================
class PolicyRulesScreen extends ConsumerWidget {
  const PolicyRulesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rules = ref.watch(policyRulesProvider);

    return AppScaffold(
      header: const AppHeader(
        title: 'Expense policy',
        subtitle: 'Applied to every reimbursement',
      ),
      child: rules.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(policyRulesProvider),
        ),
        data: (items) => items.isEmpty
            ? const EmptyState(
                icon: Icons.rule_outlined,
                title: 'No policy rules',
                message: 'Reimbursements are approved on budget alone until a '
                    'rule is added.',
              )
            : ListView(
                padding: const EdgeInsets.only(bottom: 20),
                children: [
                  const InfoBanner(
                    message: 'The agent applies these itself and cites the '
                        'rule by name in its justification. It never decides '
                        'an exception on its own — a breach escalates.',
                    tone: PillTone.info,
                    icon: Icons.gavel_outlined,
                  ),
                  const SizedBox(height: 12),
                  for (final rule in items)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: _PolicyRuleCard(rule: rule),
                    ),
                ],
              ),
      ),
    );
  }
}

class _PolicyRuleCard extends StatelessWidget {
  const _PolicyRuleCard({required this.rule});

  final Map<String, dynamic> rule;

  @override
  Widget build(BuildContext context) {
    final numeric = (rule['numeric_value'] as num?)?.toDouble();
    final currency = '${rule['currency'] ?? 'PKR'}';
    final category = rule['category'] as String?;
    final scope = rule['text_value'] as String?;
    final active = rule['active'] as bool? ?? true;

    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text('${rule['name']}', style: AppText.listTitle()),
              ),
              StatusPill(
                label: active ? 'Active' : 'Off',
                tone: active ? PillTone.success : PillTone.neutral,
                showDot: false,
              ),
            ],
          ),
          if (numeric != null) ...[
            const SizedBox(height: 6),
            Text(
              '${_ruleTypeLabel('${rule['rule_type']}')} '
              '${formatMoney(numeric, currency)}',
              style: AppText.captionStrong(AppColors.turquoise),
            ),
          ],
          const SizedBox(height: 6),
          Text('${rule['message'] ?? ''}', style: AppText.explain()),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              if (category != null && category.isNotEmpty)
                EntityChip(label: category),
              // The scope is why "Hotel nightly cap" does not fire on a
              // flight: it matches the item name, not just the category.
              if (scope != null && scope.isNotEmpty)
                EntityChip(label: 'matches "$scope"'),
            ],
          ),
        ],
      ),
    );
  }

  static String _ruleTypeLabel(String type) => switch (type) {
        'per_item_cap' => 'Cap per item:',
        'per_night_cap' => 'Cap per night:',
        'daily_cap' => 'Cap per day:',
        'total_cap' => 'Cap in total:',
        'excluded_category' => 'Not reimbursable:',
        _ => 'Limit:',
      };
}

// ===========================================================================
// Flagged vendors
// ===========================================================================
class FlaggedVendorsScreen extends ConsumerWidget {
  const FlaggedVendorsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final flagged = ref.watch(flaggedVendorsProvider);

    return AppScaffold(
      header: const AppHeader(
        title: 'Flagged vendors',
        subtitle: 'Raised by the performance monitor',
      ),
      child: flagged.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(flaggedVendorsProvider),
        ),
        data: (items) => items.isEmpty
            ? const EmptyState(
                icon: Icons.verified_outlined,
                title: 'No vendors flagged',
                message: 'Every vendor is inside its delivery thresholds.',
              )
            : RefreshIndicator(
                color: AppColors.turquoise,
                onRefresh: () async =>
                    ref.refresh(flaggedVendorsProvider.future),
                child: ListView(
                  padding: const EdgeInsets.only(bottom: 20),
                  children: [
                    const InfoBanner(
                      title: 'The monitor raises, it never suspends',
                      message: 'Flags are evidence for you to act on. '
                          'Suspending a vendor stays a human decision.',
                      tone: PillTone.warning,
                      icon: Icons.flag_outlined,
                    ),
                    const SizedBox(height: 12),
                    for (final flag in items)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: _FlagCard(flag: flag),
                      ),
                  ],
                ),
              ),
      ),
    );
  }
}

class _FlagCard extends StatelessWidget {
  const _FlagCard({required this.flag});

  final Map<String, dynamic> flag;

  @override
  Widget build(BuildContext context) {
    final raised = DateTime.tryParse('${flag['raised_at']}')?.toLocal();
    final threshold = flag['threshold'];

    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${flag['vendor_name']}',
                  style: AppText.listTitle(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              StatusPill(
                label: '${flag['vendor_status']}',
                tone: '${flag['vendor_status']}' == 'suspended'
                    ? PillTone.danger
                    : PillTone.neutral,
                showDot: false,
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(
                Icons.flag_outlined,
                size: 14,
                color: AppColors.warningFg,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '${flag['reason']}',
                  style: AppText.captionStrong(AppColors.warningFg),
                ),
              ),
            ],
          ),
          if (flag['detail'] != null) ...[
            const SizedBox(height: 6),
            Text('${flag['detail']}', style: AppText.explain()),
          ],
          const SizedBox(height: 8),
          Row(
            children: [
              if (threshold != null)
                Text('Threshold $threshold', style: AppText.meta()),
              const Spacer(),
              if (raised != null)
                Text(
                  '${raised.day}/${raised.month} '
                  '${raised.hour.toString().padLeft(2, '0')}:'
                  '${raised.minute.toString().padLeft(2, '0')}',
                  style: AppText.meta(),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
