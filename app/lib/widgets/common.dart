/// Shared primitives: pills, chips, buttons, banners, and the empty/loading/
/// error states every screen needs.
///
/// Screens compose these; they never re-style a pill or hand-roll a button.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
import '../theme/app_theme.dart';
import '../theme/surfaces.dart';
import '../theme/tokens.dart';

// ===========================================================================
// Status pill
// ===========================================================================
enum PillTone { neutral, info, success, warning, danger }

/// Public so other widget files can tint against the same tones.
extension PillColors on PillTone {
  Color get bg => switch (this) {
        PillTone.neutral => AppColors.neutralBg,
        PillTone.info => AppColors.ice,
        PillTone.success => AppColors.successBg,
        PillTone.warning => AppColors.warningBg,
        PillTone.danger => AppColors.dangerBg,
      };

  Color get fg => switch (this) {
        PillTone.neutral => AppColors.neutralFg,
        PillTone.info => AppColors.turquoise,
        PillTone.success => AppColors.successFg,
        PillTone.warning => AppColors.warningFg,
        PillTone.danger => AppColors.dangerFg,
      };
}

/// The status pill used on nearly every screen.
///
/// `padding: 3px 10px; border-radius: 999px; font: 600 11px` with a 6px dot.
class StatusPill extends StatelessWidget {
  const StatusPill({
    super.key,
    required this.label,
    this.tone = PillTone.neutral,
    this.showDot = true,
    this.icon,
    this.dense = false,
  });

  StatusPill.forWorkflow(WorkflowStatus status, {super.key})
      : label = status.label,
        showDot = true,
        dense = false,
        icon = null,
        tone = switch (status) {
          WorkflowStatus.running => PillTone.info,
          WorkflowStatus.awaitingApproval => PillTone.warning,
          WorkflowStatus.completed || WorkflowStatus.approved => PillTone.success,
          WorkflowStatus.failed ||
          WorkflowStatus.rejected ||
          WorkflowStatus.escalated =>
            PillTone.danger,
          WorkflowStatus.draft => PillTone.neutral,
        };

  StatusPill.forVendor(VendorStatus status, {super.key})
      : label = status.label,
        showDot = true,
        dense = false,
        icon = null,
        tone = switch (status) {
          VendorStatus.verified => PillTone.success,
          VendorStatus.pending => PillTone.warning,
          VendorStatus.suspended => PillTone.danger,
          VendorStatus.flagged => PillTone.danger,
        };

  final String label;
  final PillTone tone;
  final bool showDot;
  final IconData? icon;

  /// 10.5px badge sizing, as the design uses for the longer inline pills.
  final bool dense;

  @override
  Widget build(BuildContext context) => Container(
        padding: EdgeInsets.symmetric(horizontal: dense ? 9 : 10, vertical: 3),
        decoration: BoxDecoration(
          color: tone.bg,
          borderRadius: BorderRadius.circular(AppRadii.pill),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: dense ? 10 : 11, color: tone.fg),
              const SizedBox(width: 5),
            ] else if (showDot) ...[
              Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(
                  color: tone.fg,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 5),
            ],
            Flexible(
              child: Text(
                label,
                style: dense ? AppText.badge(tone.fg) : AppText.pill(tone.fg),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      );
}

/// The solid green "Best Option" badge from screens 5a and 11a.
class BestOptionBadge extends StatelessWidget {
  const BestOptionBadge({super.key});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
        decoration: BoxDecoration(
          color: AppColors.successSolid,
          borderRadius: BorderRadius.circular(AppRadii.pill),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.check, size: 10, color: AppColors.white),
            const SizedBox(width: 4),
            Text('Best Option', style: AppText.badge()),
          ],
        ),
      );
}

/// The turquoise entity chip: "Laptops × 50" (screens 2a, 11a).
class EntityChip extends StatelessWidget {
  const EntityChip({super.key, required this.label, this.tone = PillTone.info});

  final String label;
  final PillTone tone;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
        decoration: BoxDecoration(
          color: tone.bg,
          borderRadius: BorderRadius.circular(AppRadii.pill),
        ),
        child: Text(label, style: AppText.chip(tone.fg)),
      );
}

/// A selectable filter chip (screen 10a).
class FilterChipButton extends StatelessWidget {
  const FilterChipButton({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 7),
          decoration: BoxDecoration(
            color: selected ? AppColors.turquoise : AppColors.neutralBg,
            borderRadius: BorderRadius.circular(AppRadii.pill),
          ),
          child: Text(
            label,
            style: AppText.chip(
              selected ? AppColors.white : AppColors.neutralFg,
            ),
          ),
        ),
      );
}

// ===========================================================================
// Buttons
// ===========================================================================
/// The gradient CTA. `height 52-54, radius 24-99, gradient 160deg`.
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.trailingIcon,
    this.height = 52,
    this.radius = AppRadii.panel,
    this.busy = false,
    this.haptic = HapticFeedback.mediumImpact,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final IconData? trailingIcon;
  final double height;
  final double radius;
  final bool busy;
  final Future<void> Function() haptic;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    return Opacity(
      opacity: enabled ? 1 : 0.5,
      child: GestureDetector(
        onTap: enabled
            ? () {
                haptic();
                onPressed!();
              }
            : null,
        child: Container(
          height: height,
          decoration: BoxDecoration(
            gradient: AppGradients.cta,
            borderRadius: BorderRadius.circular(radius),
            boxShadow: enabled ? AppShadows.cta : const [],
          ),
          alignment: Alignment.center,
          child: busy
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    valueColor: AlwaysStoppedAnimation(AppColors.white),
                  ),
                )
              : Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (icon != null) ...[
                      Icon(icon, size: 18, color: AppColors.white),
                      const SizedBox(width: 8),
                    ],
                    Text(label, style: AppText.button()),
                    if (trailingIcon != null) ...[
                      const SizedBox(width: 8),
                      Icon(trailingIcon, size: 15, color: AppColors.white),
                    ],
                  ],
                ),
        ),
      ),
    );
  }
}

/// A glass-backed secondary action.
class SecondaryButton extends StatelessWidget {
  const SecondaryButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.height = 52,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final double height;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onPressed,
        child: Container(
          height: height,
          decoration: BoxDecoration(
            color: AppColors.white,
            borderRadius: BorderRadius.circular(AppRadii.panel),
            border: Border.all(color: AppColors.glacier, width: 1.5),
          ),
          alignment: Alignment.center,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 18, color: AppColors.turquoise),
                const SizedBox(width: 8),
              ],
              Text(label, style: AppText.button(AppColors.turquoise)),
            ],
          ),
        ),
      );
}

/// Reject / suspend / delete. Heavy haptic per the brief.
class DangerButton extends StatelessWidget {
  const DangerButton({
    super.key,
    required this.label,
    this.onPressed,
    this.height = 52,
  });

  final String label;
  final VoidCallback? onPressed;
  final double height;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onPressed == null
            ? null
            : () {
                HapticFeedback.heavyImpact();
                onPressed!();
              },
        child: Container(
          height: height,
          decoration: BoxDecoration(
            color: AppColors.dangerBg,
            borderRadius: BorderRadius.circular(AppRadii.panel),
            border: Border.all(color: AppColors.dangerBorder, width: 1.5),
          ),
          alignment: Alignment.center,
          child: Text(label, style: AppText.button(AppColors.dangerFg)),
        ),
      );
}

// ===========================================================================
// Banners
// ===========================================================================
/// The tinted explanation banner: the agent justification on 5a/11a, the
/// "catalog is live" note on 14a, escalation warnings.
class InfoBanner extends StatelessWidget {
  const InfoBanner({
    super.key,
    required this.message,
    this.tone = PillTone.success,
    this.icon,
    this.title,
    this.clay = false,
  });

  final String message;
  final PillTone tone;
  final IconData? icon;
  final String? title;

  /// Vendor-portal variant (screen 14d) uses the clay treatment.
  final bool clay;

  @override
  Widget build(BuildContext context) {
    final border = switch (tone) {
      PillTone.success => AppColors.successBorder,
      PillTone.warning => AppColors.warningBorder,
      PillTone.danger => AppColors.dangerBorder,
      PillTone.info => AppColors.glacier,
      PillTone.neutral => AppColors.divider,
    };

    final content = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (icon != null) ...[
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Icon(icon, size: 18, color: tone.fg),
          ),
          const SizedBox(width: 10),
        ],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (title != null) ...[
                Text(title!, style: AppText.captionStrong(tone.fg)),
                const SizedBox(height: 3),
              ],
              Text(message, style: AppText.explain(tone.fg)),
            ],
          ),
        ),
      ],
    );

    if (clay) {
      return ClayCard(
        radius: AppRadii.panel,
        color: tone.bg,
        shadows: AppShadows.claySmall,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: content,
      );
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: tone.bg,
        borderRadius: BorderRadius.circular(AppRadii.panel),
        border: Border.all(color: border),
      ),
      child: content,
    );
  }
}

// ===========================================================================
// States
// ===========================================================================
class LoadingState extends StatelessWidget {
  const LoadingState({super.key, this.label});

  final String? label;

  @override
  Widget build(BuildContext context) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(
              width: 26,
              height: 26,
              child: CircularProgressIndicator(
                strokeWidth: 2.4,
                valueColor: AlwaysStoppedAnimation(AppColors.turquoise),
              ),
            ),
            if (label != null) ...[
              const SizedBox(height: 14),
              Text(label!, style: AppText.caption()),
            ],
          ],
        ),
      );
}

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.title,
    this.message,
    this.icon = Icons.inbox_outlined,
    this.action,
  });

  final String title;
  final String? message;
  final IconData icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: const BoxDecoration(
                  color: AppColors.ice,
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, color: AppColors.turquoise, size: 26),
              ),
              const SizedBox(height: 16),
              Text(title, style: AppText.sectionTitle(), textAlign: TextAlign.center),
              if (message != null) ...[
                const SizedBox(height: 6),
                Text(
                  message!,
                  style: AppText.caption(),
                  textAlign: TextAlign.center,
                ),
              ],
              if (action != null) ...[const SizedBox(height: 18), action!],
            ],
          ),
        ),
      );
}

class ErrorState extends StatelessWidget {
  const ErrorState({
    super.key,
    required this.message,
    this.onRetry,
    this.title = 'Something went wrong',
  });

  final String message;
  final VoidCallback? onRetry;
  final String title;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: const BoxDecoration(
                  color: AppColors.dangerBg,
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.error_outline,
                  color: AppColors.dangerFg,
                  size: 26,
                ),
              ),
              const SizedBox(height: 16),
              Text(title, style: AppText.sectionTitle(), textAlign: TextAlign.center),
              const SizedBox(height: 6),
              Text(message, style: AppText.caption(), textAlign: TextAlign.center),
              if (onRetry != null) ...[
                const SizedBox(height: 18),
                SizedBox(
                  width: 160,
                  child: SecondaryButton(
                    label: 'Try again',
                    icon: Icons.refresh,
                    height: 44,
                    onPressed: onRetry,
                  ),
                ),
              ],
            ],
          ),
        ),
      );
}

/// A shimmering placeholder row, used while a list loads.
class SkeletonBox extends StatefulWidget {
  const SkeletonBox({
    super.key,
    this.height = 16,
    this.width,
    this.radius = AppRadii.tiny,
  });

  final double height;
  final double? width;
  final double radius;

  @override
  State<SkeletonBox> createState() => _SkeletonBoxState();
}

class _SkeletonBoxState extends State<SkeletonBox>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _c,
        builder: (_, __) => Container(
          height: widget.height,
          width: widget.width,
          decoration: BoxDecoration(
            color: Color.lerp(
              AppColors.divider,
              AppColors.dividerSoft,
              _c.value,
            ),
            borderRadius: BorderRadius.circular(widget.radius),
          ),
        ),
      );
}

// ===========================================================================
// Misc
// ===========================================================================
/// The gradient avatar circle with initials (screens 1a, 14a).
class AvatarCircle extends StatelessWidget {
  const AvatarCircle({
    super.key,
    required this.initials,
    this.size = 42,
    this.borderWidth = 2,
  });

  final String initials;
  final double size;
  final double borderWidth;

  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          gradient: AppGradients.cta,
          shape: BoxShape.circle,
          border: Border.all(
            color: const Color(0x38FFFFFF),
            width: borderWidth,
          ),
        ),
        alignment: Alignment.center,
        child: Text(
          initials,
          style: AppText.listTitle(AppColors.white).copyWith(fontSize: size / 3),
        ),
      );
}

/// A label/value row inside a card. The design pairs a muted label with a
/// bold value on the same line.
class MetaRow extends StatelessWidget {
  const MetaRow({
    super.key,
    required this.label,
    required this.value,
    this.valueColor = AppColors.ink,
  });

  final String label;
  final String value;
  final Color valueColor;

  @override
  Widget build(BuildContext context) => RichText(
        text: TextSpan(
          style: AppText.caption(),
          children: [
            TextSpan(text: '$label '),
            TextSpan(text: value, style: AppText.captionStrong(valueColor)),
          ],
        ),
      );
}

/// A hairline divider matching the design's #E7EFF3.
class HairLine extends StatelessWidget {
  const HairLine({super.key, this.color = AppColors.divider});

  final Color color;

  @override
  Widget build(BuildContext context) => Container(height: 1, color: color);
}

/// Formats money the way the design does: "PKR 8,700,000" -- no decimals on
/// whole amounts, thousands separated.
String formatMoney(num? amount, [String currency = 'PKR']) {
  if (amount == null) return '—';
  final whole = amount.round();
  final digits = whole.abs().toString();
  final buf = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buf.write(',');
    buf.write(digits[i]);
  }
  return '$currency ${whole < 0 ? '-' : ''}$buf';
}

/// "2 years" / "18 months" -- the design prefers years when it divides evenly.
String formatWarranty(int? months) {
  if (months == null) return '—';
  if (months % 12 == 0) {
    final y = months ~/ 12;
    return '$y year${y == 1 ? '' : 's'}';
  }
  return '$months months';
}

String formatDuration(int? ms) {
  if (ms == null) return '—';
  if (ms < 1000) return '${ms}ms';
  if (ms < 60000) return '${(ms / 1000).toStringAsFixed(1)}s';
  return '${(ms / 60000).toStringAsFixed(1)}m';
}
