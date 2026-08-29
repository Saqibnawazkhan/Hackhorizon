/// App chrome: screen headers, the glass bottom nav, and the page scaffold.
library;

import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../theme/surfaces.dart';
import '../theme/tokens.dart';

/// The standard screen header: back chevron, title, optional subtitle and a
/// trailing slot.
///
/// The design pairs a 20px/700 title with a 12px muted subtitle, e.g.
/// "Supplier Comparison" / "Step 4 · Score & rank suppliers".
class AppHeader extends StatelessWidget {
  const AppHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.trailing,
    this.showBack = true,
    this.onBack,
  });

  final String title;
  final String? subtitle;
  final Widget? trailing;
  final bool showBack;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.page,
          6,
          AppSpacing.page,
          10,
        ),
        child: Row(
          children: [
            if (showBack) ...[
              GestureDetector(
                onTap: onBack ?? () => Navigator.of(context).maybePop(),
                behavior: HitTestBehavior.opaque,
                child: const Padding(
                  padding: EdgeInsets.only(right: 10, top: 4, bottom: 4),
                  child: Icon(
                    Icons.arrow_back_ios_new,
                    size: 20,
                    color: AppColors.inkStrong,
                  ),
                ),
              ),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: AppText.pageTitle()),
                  if (subtitle != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 1),
                      child: Text(subtitle!, style: AppText.caption()),
                    ),
                ],
              ),
            ),
            if (trailing != null) trailing!,
          ],
        ),
      );
}

/// Destinations in the bottom bar, mirroring NavBar.dc.html.
enum NavTab {
  home('Home', Icons.home_rounded),
  workflows('Workflows', Icons.account_tree_rounded),
  approvals('Approvals', Icons.check_circle_rounded),
  reports('Reports', Icons.insert_chart_rounded);

  const NavTab(this.label, this.icon);
  final String label;
  final IconData icon;
}

/// The glass bottom navigation with its centre FAB.
///
/// From NavBar.dc.html: a blur(20) saturate(1.6) pill holding two tabs, a
/// 46px gradient FAB, then two more tabs. The active tab is #2E5163 with a
/// turquoise dot beneath; inactive is #9DB4BE with no dot.
class AppBottomNav extends StatelessWidget {
  const AppBottomNav({
    super.key,
    required this.active,
    required this.onSelect,
    this.onFab,
    this.tabs = NavTab.values,
  });

  final NavTab active;
  final ValueChanged<NavTab> onSelect;
  final VoidCallback? onFab;
  final List<NavTab> tabs;

  static const _activeColor = Color(0xFF2E5163);
  static const _inactiveColor = Color(0xFF9DB4BE);

  @override
  Widget build(BuildContext context) {
    final left = tabs.take(2).toList();
    final right = tabs.skip(2).toList();

    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 6, 14, 12),
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppRadii.card),
          boxShadow: AppShadows.nav,
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(AppRadii.card),
          child: BackdropFilter(
            filter: ImageFilter.blur(
              sigmaX: AppBlurs.nav / 2,
              sigmaY: AppBlurs.nav / 2,
            ),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                gradient: AppGradients.glassSoft,
                borderRadius: BorderRadius.circular(AppRadii.card),
                border: Border.all(color: const Color(0xCCFFFFFF)),
              ),
              child: Row(
                children: [
                  for (final t in left) Expanded(child: _tab(t)),
                  if (onFab != null) _fab(),
                  for (final t in right) Expanded(child: _tab(t)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _tab(NavTab tab) {
    final on = tab == active;
    return GestureDetector(
      onTap: () => onSelect(tab),
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              tab.icon,
              size: 22,
              color: on ? _activeColor : _inactiveColor,
            ),
            const SizedBox(height: 4),
            Container(
              width: 4,
              height: 4,
              decoration: BoxDecoration(
                color: on ? AppColors.turquoise : Colors.transparent,
                shape: BoxShape.circle,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _fab() => GestureDetector(
        onTap: onFab,
        child: Container(
          width: 46,
          height: 46,
          margin: const EdgeInsets.symmetric(horizontal: 6),
          decoration: BoxDecoration(
            gradient: AppGradients.cta,
            shape: BoxShape.circle,
            boxShadow: const [
              BoxShadow(
                color: Color(0x592E6078),
                blurRadius: 22,
                offset: Offset(0, 10),
              ),
            ],
          ),
          child: const Icon(Icons.add, size: 20, color: AppColors.white),
        ),
      );
}

/// A screen scaffold that applies the page background and safe areas.
///
/// The design's 58px top padding is iOS-frame chrome from the mock, not a
/// real inset -- this uses the device's actual safe area instead, so the
/// layout is correct on any phone.
class AppScaffold extends StatelessWidget {
  const AppScaffold({
    super.key,
    required this.child,
    this.header,
    this.bottomNav,
    this.footer,
    this.vendor = false,
    this.padHorizontal = true,
  });

  final Widget child;
  final Widget? header;
  final Widget? bottomNav;

  /// A sticky action pinned above the nav (e.g. "Publish Updates" on 14a).
  final Widget? footer;

  /// Vendor screens use a flat white ground rather than the radial washes.
  final bool vendor;
  final bool padHorizontal;

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: Colors.transparent,
        body: PageBackground(
          vendor: vendor,
          child: SafeArea(
            bottom: false,
            child: Column(
              children: [
                if (header != null) header!,
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.symmetric(
                      horizontal: padHorizontal ? AppSpacing.page : 0,
                    ),
                    child: child,
                  ),
                ),
                if (footer != null)
                  Padding(
                    padding: EdgeInsets.fromLTRB(
                      AppSpacing.page,
                      10,
                      AppSpacing.page,
                      bottomNav == null
                          ? MediaQuery.paddingOf(context).bottom + 12
                          : 0,
                    ),
                    child: footer!,
                  ),
                if (bottomNav != null)
                  Padding(
                    padding: EdgeInsets.only(
                      bottom: MediaQuery.paddingOf(context).bottom,
                    ),
                    child: bottomNav!,
                  ),
              ],
            ),
          ),
        ),
      );
}

/// A titled section with an optional trailing action, e.g.
/// "Recent workflows" / "View all".
class SectionHeader extends StatelessWidget {
  const SectionHeader({
    super.key,
    required this.title,
    this.actionLabel,
    this.onAction,
  });

  final String title;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) => Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          Expanded(child: Text(title, style: AppText.sectionTitle())),
          if (actionLabel != null)
            GestureDetector(
              onTap: onAction,
              child: Text(
                actionLabel!,
                style: AppText.listTitle(AppColors.turquoise)
                    .copyWith(fontSize: AppTypeScale.bodySm),
              ),
            ),
        ],
      );
}

/// A full-width glass panel holding a list, with hairlines between rows.
class ListPanel extends StatelessWidget {
  const ListPanel({super.key, required this.children, this.padding});

  final List<Widget> children;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) => GlassCard(
        padding: padding ?? EdgeInsets.zero,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        ),
      );
}

/// Shows a transient message using the app's snackbar style.
void showToast(BuildContext context, String message, {bool danger = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: Text(
          message,
          style: AppText.caption(AppColors.white),
        ),
        backgroundColor: danger ? AppColors.dangerFg : AppColors.ink,
        duration: const Duration(seconds: 3),
      ),
    );
}
