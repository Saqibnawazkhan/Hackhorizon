/// Workflow-specific widgets: the execution stepper, tool log, score bar,
/// vendor comparison cards, coverage matrix, validation rows and timeline.
///
/// These carry most of the design's distinctive detail, so each documents the
/// screen it comes from.
library;

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../theme/app_theme.dart';
import '../theme/surfaces.dart';
import '../theme/tokens.dart';
import 'common.dart';

// ===========================================================================
// Workflow list tile -- screens 1a, 10a
// ===========================================================================
class WorkflowTile extends StatelessWidget {
  const WorkflowTile({
    super.key,
    required this.workflow,
    this.onTap,
    this.showDivider = true,
  });

  final WorkflowSummary workflow;
  final VoidCallback? onTap;
  final bool showDivider;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
          decoration: BoxDecoration(
            border: showDivider
                ? const Border(
                    bottom: BorderSide(color: AppColors.divider),
                  )
                : null,
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      workflow.title,
                      style: AppText.listTitle(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 1),
                    Text(workflow.subtitle, style: AppText.caption(AppColors.subtle)),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              StatusPill.forWorkflow(workflow.status),
            ],
          ),
        ),
      );
}

// ===========================================================================
// Execution stepper -- screens 3a, 4a, 4b
// ===========================================================================
/// One row of the execution stepper.
///
/// The design distinguishes four visual states: pending (hollow ring),
/// running (spinner), completed (filled tick) and failed/retrying (amber or
/// red). A retrying step shows its attempt count, which is what makes the
/// self-correction visible rather than merely logged.
class StepRow extends StatelessWidget {
  const StepRow({
    super.key,
    required this.step,
    this.isLast = false,
    this.expanded = false,
    this.onTap,
  });

  final WorkflowStep step;
  final bool isLast;

  /// Screen 4a shows the tool log expanded under the active step.
  final bool expanded;
  final VoidCallback? onTap;

  Color get _accent => switch (step.status) {
        StepStatus.completed => AppColors.successFg,
        StepStatus.running => AppColors.turquoise,
        StepStatus.retrying => AppColors.warningFg,
        StepStatus.failed => AppColors.dangerFg,
        StepStatus.skipped => AppColors.disabled,
        StepStatus.pending => AppColors.disabled,
      };

  @override
  Widget build(BuildContext context) {
    final active = step.isActive;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // -- rail: marker plus the connecting line ------------------
            SizedBox(
              width: 26,
              child: Column(
                children: [
                  _Marker(status: step.status, accent: _accent),
                  if (!isLast)
                    Container(
                      width: 2,
                      height: expanded ? 62 : 26,
                      margin: const EdgeInsets.symmetric(vertical: 2),
                      decoration: BoxDecoration(
                        color: step.status == StepStatus.completed
                            ? AppColors.successBorder
                            : AppColors.divider,
                        borderRadius: BorderRadius.circular(1),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            step.title,
                            style: AppText.listTitle(
                              active ? AppColors.ink : AppColors.muted,
                            ),
                          ),
                        ),
                        if (step.durationMs != null)
                          Text(
                            formatDuration(step.durationMs),
                            style: AppText.meta(),
                          ),
                        if (step.isRetrying)
                          StatusPill(
                            label: 'Retry ${step.retryCount}/${step.maxRetries}',
                            tone: PillTone.warning,
                            showDot: false,
                          ),
                      ],
                    ),
                    if (step.description != null && active) ...[
                      const SizedBox(height: 2),
                      Text(step.description!, style: AppText.meta()),
                    ],
                    if (step.error != null) ...[
                      const SizedBox(height: 5),
                      Text(
                        step.error!,
                        style: AppText.meta(AppColors.dangerFg),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                    // Screen 4a: the expanded tool log.
                    if (expanded && step.toolCalls.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      ...step.toolCalls.map((c) => ToolLogRow(call: c)),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Marker extends StatelessWidget {
  const _Marker({required this.status, required this.accent});

  final StepStatus status;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    const size = 22.0;
    return switch (status) {
      StepStatus.completed => Container(
          width: size,
          height: size,
          decoration: BoxDecoration(color: accent, shape: BoxShape.circle),
          child: const Icon(Icons.check, size: 13, color: AppColors.white),
        ),
      StepStatus.running => SizedBox(
          width: size,
          height: size,
          child: CircularProgressIndicator(
            strokeWidth: 2.2,
            valueColor: AlwaysStoppedAnimation(accent),
          ),
        ),
      StepStatus.retrying => Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: AppColors.warningBg,
            shape: BoxShape.circle,
            border: Border.all(color: accent, width: 2),
          ),
          child: Icon(Icons.refresh, size: 12, color: accent),
        ),
      StepStatus.failed => Container(
          width: size,
          height: size,
          decoration: BoxDecoration(color: accent, shape: BoxShape.circle),
          child: const Icon(Icons.close, size: 13, color: AppColors.white),
        ),
      _ => Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: AppColors.disabled, width: 2),
          ),
        ),
    };
  }
}

/// One line of the tool log: "catalog_query · 412ms · success" (screen 4a).
class ToolLogRow extends StatelessWidget {
  const ToolLogRow({super.key, required this.call});

  final ToolCall call;

  @override
  Widget build(BuildContext context) {
    final failed = call.status != 'success';
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: failed ? AppColors.dangerBg : AppColors.divider,
        borderRadius: BorderRadius.circular(AppRadii.chip),
      ),
      child: Row(
        children: [
          Icon(
            failed ? Icons.error_outline : Icons.bolt,
            size: 12,
            color: failed ? AppColors.dangerFg : AppColors.turquoise,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              call.toolName,
              style: AppText.mono(10.5, AppColors.neutralFg),
            ),
          ),
          if (call.retryCount > 0) ...[
            Text('${call.retryCount} retries', style: AppText.micro(AppColors.warningFg)),
            const SizedBox(width: 8),
          ],
          Text('${call.durationMs}ms', style: AppText.micro()),
        ],
      ),
    );
  }
}

// ===========================================================================
// Score bar -- screen 5a
// ===========================================================================
/// The stacked weighted-score bar.
///
/// Each segment is one criterion's CONTRIBUTION out of 100, so the widths are
/// the actual maths rather than a decorative approximation. The track is
/// #E7EFF3 and the segments run turquoise -> slate -> glacier, matching the
/// legend beneath.
class ScoreBreakdownBar extends StatelessWidget {
  const ScoreBreakdownBar({
    super.key,
    required this.label,
    required this.components,
    required this.total,
    this.dimmed = false,
    this.excludedLabel,
  });

  final String label;
  final List<ScoreComponent> components;
  final double? total;
  final bool dimmed;

  /// Renders an empty track with a dash instead of a score (excluded vendor).
  final String? excludedLabel;

  static const _segmentColors = <String, Color>{
    'price': AppColors.turquoise,
    'delivery': AppColors.slate,
    'warranty': AppColors.glacier,
    'reliability': AppColors.platinum,
  };

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(
          children: [
            SizedBox(
              width: 104,
              child: Text(
                label,
                style: AppText.captionStrong(
                  dimmed ? AppColors.subtle : AppColors.ink,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Container(
                height: 14,
                decoration: BoxDecoration(
                  color: AppColors.divider,
                  borderRadius: BorderRadius.circular(AppRadii.pill),
                ),
                clipBehavior: Clip.antiAlias,
                child: excludedLabel != null
                    ? const SizedBox.shrink()
                    : Row(
                        // stretch, or each ColoredBox collapses to zero height
                        // and the bar renders as an empty track.
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          for (final c in components)
                            Expanded(
                              flex: (c.contribution * 100).round().clamp(0, 100000),
                              child: ColoredBox(
                                color: _segmentColors[c.criterion] ??
                                    AppColors.platinum,
                              ),
                            ),
                          // The unearned remainder stays as track.
                          Expanded(
                            flex: (((100 - (total ?? 0)) * 100).round())
                                .clamp(0, 100000),
                            child: const SizedBox.shrink(),
                          ),
                        ],
                      ),
              ),
            ),
            const SizedBox(width: 10),
            SizedBox(
              width: 28,
              child: Text(
                excludedLabel ?? (total?.round().toString() ?? '—'),
                textAlign: TextAlign.right,
                style: excludedLabel != null
                    ? AppText.pill(AppColors.dangerFg)
                    : AppText.captionStrong(
                        dimmed ? AppColors.subtle : AppColors.turquoise,
                      ),
              ),
            ),
          ],
        ),
      );
}

/// The three-swatch legend under the score bars (screen 5a).
class ScoreLegend extends StatelessWidget {
  const ScoreLegend({super.key, this.criteria = const ['price', 'delivery', 'warranty']});

  final List<String> criteria;

  @override
  Widget build(BuildContext context) => Row(
        children: [
          for (final c in criteria) ...[
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: ScoreBreakdownBar._segmentColors[c] ?? AppColors.platinum,
                borderRadius: BorderRadius.circular(AppRadii.swatch),
              ),
            ),
            const SizedBox(width: 5),
            Text(
              c[0].toUpperCase() + c.substring(1),
              style: AppText.micro(),
            ),
            const SizedBox(width: 14),
          ],
        ],
      );
}

// ===========================================================================
// Vendor comparison card -- screens 5a, 11a
// ===========================================================================
/// One supplier card.
///
/// The surface treatment carries meaning: the winner is a solid white card
/// with a green outline, runners-up are liquid glass, and an excluded vendor
/// is a de-emphasised translucent card with a red border. That mapping is the
/// design's, not an invention.
class VendorQuoteCard extends StatelessWidget {
  const VendorQuoteCard({
    super.key,
    required this.quote,
    this.showLines = false,
    this.onTap,
  });

  final Quote quote;

  /// Screen 11a lists every requested line inside the card.
  final bool showLines;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final excluded = quote.status.isExcluded;
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                quote.vendorName,
                style: AppText.sectionTitle(
                  excluded ? AppColors.muted : AppColors.ink,
                ),
              ),
            ),
            if (quote.reliabilityHasHistory && !showLines) ...[
              const Icon(Icons.star_rounded, size: 13, color: AppColors.warningFg),
              const SizedBox(width: 2),
              Text(
                quote.reliabilityLabel,
                style: AppText.captionStrong(AppColors.warningFg),
              ),
              const SizedBox(width: 8),
            ],
            // Coverage can be long ("Covers 2/3 - no CPU kit"), so it is
            // flexible rather than fixed; without this the row overflows on a
            // narrow phone.
            if (quote.itemsRequested > 1) ...[
              Flexible(
                child: StatusPill(
                  label: quote.coverageLabel,
                  tone: quote.isPartial ? PillTone.warning : PillTone.success,
                  showDot: false,
                  dense: true,
                ),
              ),
              const SizedBox(width: 6),
            ],
            if (quote.isSelected) const BestOptionBadge(),
            if (excluded && !(showLines && quote.isPartial))
              Flexible(
                child: StatusPill(
                  label: quote.exclusionReason ?? 'Excluded',
                  tone: PillTone.danger,
                  showDot: false,
                  dense: true,
                  icon: Icons.warning_amber_rounded,
                ),
              ),
          ],
        ),

        // -- new-vendor caveat: never a fabricated rating ---------------
        if (!quote.reliabilityHasHistory) ...[
          const SizedBox(height: 6),
          Row(
            children: [
              const Icon(Icons.info_outline, size: 12, color: AppColors.subtle),
              const SizedBox(width: 5),
              Text('New vendor — no fulfilment history', style: AppText.meta()),
            ],
          ),
        ],

        const SizedBox(height: 8),

        if (showLines) ...[
          for (final line in quote.lines) _LineRow(line: line, quote: quote),
          const SizedBox(height: 4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Row(
                  children: [
                    Flexible(
                      child: Text(
                        [
                          if (quote.deliveryDays != null)
                            'Delivery ${quote.deliveryDays} days',
                          if (quote.warrantyMonths != null)
                            'Warranty ${formatWarranty(quote.warrantyMonths)}',
                        ].join(' · '),
                        style: AppText.meta(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    // An icon, not a literal star: Instrument Sans has no
                    // glyph for U+2605 and renders it as a tofu box.
                    if (quote.reliabilityHasHistory) ...[
                      Text(' · ', style: AppText.meta()),
                      const Icon(
                        Icons.star_rounded,
                        size: 12,
                        color: AppColors.warningFg,
                      ),
                      Text(
                        quote.reliabilityLabel,
                        style: AppText.meta(AppColors.warningFg),
                      ),
                    ],
                  ],
                ),
              ),
              Text(
                '${formatMoney(quote.totalAmount, quote.currency)}'
                '${quote.isPartial ? '*' : ''}',
                style: AppText.listTitle(
                  excluded ? AppColors.dangerFg : AppColors.turquoise,
                ),
              ),
            ],
          ),
        ] else
          // Screen 5a's 2x2 metadata grid.
          Wrap(
            spacing: 12,
            runSpacing: 4,
            children: [
              SizedBox(
                width: 150,
                child: MetaRow(
                  label: 'Unit price',
                  value: formatMoney(
                    quote.lines.isNotEmpty ? quote.lines.first.unitPrice : null,
                    quote.currency,
                  ),
                  valueColor: excluded ? AppColors.muted : AppColors.ink,
                ),
              ),
              SizedBox(
                width: 150,
                child: MetaRow(
                  label: 'Total',
                  value: formatMoney(quote.totalAmount, quote.currency),
                  valueColor: excluded ? AppColors.dangerFg : AppColors.ink,
                ),
              ),
              SizedBox(
                width: 150,
                child: MetaRow(
                  label: 'Delivery',
                  value: quote.deliveryDays == null
                      ? '—'
                      : '${quote.deliveryDays} days',
                  valueColor: excluded ? AppColors.muted : AppColors.ink,
                ),
              ),
              SizedBox(
                width: 150,
                child: MetaRow(
                  label: 'Warranty',
                  value: formatWarranty(quote.warrantyMonths),
                  valueColor: excluded ? AppColors.muted : AppColors.ink,
                ),
              ),
            ],
          ),

        // -- data confidence, shown wherever it is below 100% ------------
        if (quote.confidenceLabel != null && (quote.confidencePercent ?? 100) < 100) ...[
          const SizedBox(height: 8),
          Row(
            children: [
              const Icon(Icons.help_outline, size: 12, color: AppColors.warningFg),
              const SizedBox(width: 5),
              Expanded(
                child: Text(
                  quote.confidenceLabel!,
                  style: AppText.meta(AppColors.warningFg),
                ),
              ),
            ],
          ),
        ],
      ],
    );

    if (quote.isSelected) {
      return OutlinedSurface(onTap: onTap, child: body);
    }
    if (excluded) {
      return MutedSurface(child: body);
    }
    return GlassCard(
      onTap: onTap,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: body,
    );
  }
}

class _LineRow extends StatelessWidget {
  const _LineRow({required this.line, required this.quote});

  final QuoteLine line;
  final Quote quote;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(vertical: 6),
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: AppColors.divider)),
        ),
        child: Row(
          children: [
            Expanded(
              child: RichText(
                text: TextSpan(
                  style: AppText.caption(),
                  children: [
                    TextSpan(text: line.matchedTitle ?? line.requestItemName),
                    if (line.available)
                      TextSpan(
                        text: '  × ${line.quantity}',
                        style: AppText.captionStrong(),
                      ),
                  ],
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 8),
            Text(
              line.available
                  ? formatMoney(line.lineTotal, quote.currency)
                      .replaceFirst('${quote.currency} ', '')
                  : 'Not stocked',
              style: line.available
                  ? AppText.captionStrong()
                  : AppText.captionStrong(AppColors.warningFg),
            ),
          ],
        ),
      );
}

// ===========================================================================
// Validation -- screens 6a, 6b
// ===========================================================================
class ValidationCheckRow extends StatelessWidget {
  const ValidationCheckRow({super.key, required this.check});

  final ValidationCheck check;

  @override
  Widget build(BuildContext context) {
    final tone = switch (check.outcome) {
      ValidationOutcome.passed => PillTone.success,
      ValidationOutcome.failed => PillTone.danger,
      ValidationOutcome.warning => PillTone.warning,
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: tone.bg,
        borderRadius: BorderRadius.circular(AppRadii.banner),
        border: Border.all(
          color: switch (check.outcome) {
            ValidationOutcome.passed => AppColors.successBorder,
            ValidationOutcome.failed => AppColors.dangerBorder,
            ValidationOutcome.warning => AppColors.warningBorder,
          },
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            switch (check.outcome) {
              ValidationOutcome.passed => Icons.check_circle,
              ValidationOutcome.failed => Icons.cancel,
              ValidationOutcome.warning => Icons.warning_amber_rounded,
            },
            size: 18,
            color: tone.fg,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(check.title, style: AppText.listTitle(tone.fg)),
                const SizedBox(height: 3),
                Text(check.message, style: AppText.explain(tone.fg)),
                // Screen 6b: expected vs actual is what makes a failure
                // actionable rather than merely alarming.
                if (!check.passed && check.expected != null) ...[
                  const SizedBox(height: 6),
                  _ExpectedActual(
                    expected: check.expected!,
                    actual: check.actual ?? '—',
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ExpectedActual extends StatelessWidget {
  const _ExpectedActual({required this.expected, required this.actual});

  final String expected;
  final String actual;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: AppColors.white.withValues(alpha: 0.6),
          borderRadius: BorderRadius.circular(AppRadii.chip),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(width: 58, child: Text('Expected', style: AppText.micro())),
                Expanded(child: Text(expected, style: AppText.meta(AppColors.ink))),
              ],
            ),
            const SizedBox(height: 3),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(width: 58, child: Text('Actual', style: AppText.micro())),
                Expanded(
                  child: Text(actual, style: AppText.meta(AppColors.dangerFg)),
                ),
              ],
            ),
          ],
        ),
      );
}

// ===========================================================================
// Audit timeline -- screen 10b
// ===========================================================================
class TimelineRow extends StatelessWidget {
  const TimelineRow({
    super.key,
    required this.event,
    this.isLast = false,
  });

  final AuditEvent event;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    final color = switch (event.source) {
      'tool_call' => AppColors.slate,
      'approval' => AppColors.warningFg,
      'system' => AppColors.subtle,
      _ => AppColors.turquoise,
    };
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 58,
          child: Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Text(
              '${event.at.hour.toString().padLeft(2, '0')}:'
              '${event.at.minute.toString().padLeft(2, '0')}:'
              '${event.at.second.toString().padLeft(2, '0')}',
              style: AppText.mono(10, AppColors.subtle),
            ),
          ),
        ),
        Column(
          children: [
            Container(
              width: 9,
              height: 9,
              margin: const EdgeInsets.only(top: 4),
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
            if (!isLast)
              Container(
                width: 2,
                height: 34,
                margin: const EdgeInsets.symmetric(vertical: 2),
                color: AppColors.divider,
              ),
          ],
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(bottom: 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(child: Text(event.event, style: AppText.listTitle())),
                    if (event.durationMs != null)
                      Text(formatDuration(event.durationMs), style: AppText.meta()),
                  ],
                ),
                if (event.detail != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    event.detail!,
                    style: AppText.meta(),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
                const SizedBox(height: 3),
                Row(
                  children: [
                    Text(event.actor, style: AppText.micro(color)),
                    if (event.status != null) ...[
                      Text('  ·  ', style: AppText.micro()),
                      Text(event.status!, style: AppText.micro()),
                    ],
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

// ===========================================================================
// Stat card -- screens 1a, 17a
// ===========================================================================
class StatCard extends StatelessWidget {
  const StatCard({
    super.key,
    required this.value,
    required this.label,
    this.tone = 'neutral',
    this.onTap,
  });

  final String value;
  final String label;
  final String tone;
  final VoidCallback? onTap;

  Color get _color => switch (tone) {
        'warning' => AppColors.warningFg,
        'positive' => AppColors.successFg,
        'danger' => AppColors.dangerFg,
        _ => AppColors.turquoise,
      };

  @override
  Widget build(BuildContext context) => GlassCard(
        onTap: onTap,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(value, style: AppText.stat(_color)),
            const SizedBox(height: 2),
            Text(
              label,
              style: AppText.meta(AppColors.muted).copyWith(height: 1.35),
              maxLines: 2,
            ),
          ],
        ),
      );
}
