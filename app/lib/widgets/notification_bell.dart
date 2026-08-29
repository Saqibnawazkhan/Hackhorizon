/// The notification bell, with its unread badge.
///
/// Sits on every screen that has a header or a hero, because the thing it
/// announces — a run that has stopped and needs you — is not something you
/// should have to navigate somewhere to discover.
///
/// The count comes from the server, not from anything the client tallies.
/// Read state is per user and lives in one place; a bell that counts locally
/// disagrees with itself the moment you open the app on a second device.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/providers.dart';
import '../theme/app_theme.dart';
import '../theme/tokens.dart';
import '../screens/notifications_screen.dart';

class NotificationBell extends ConsumerWidget {
  const NotificationBell({
    super.key,
    this.color = AppColors.ink,
    this.size = 22,
  });

  /// The hero cards are dark, so the bell there is drawn light.
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Never blocks the screen: while the count is loading or has failed, the
    // bell renders without a badge rather than not at all.
    final unread = ref.watch(unreadCountProvider).maybeWhen(
          data: (n) => n,
          orElse: () => 0,
        );

    return GestureDetector(
      onTap: () {
        HapticFeedback.selectionClick();
        Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const NotificationsScreen()),
        );
      },
      behavior: HitTestBehavior.opaque,
      child: Padding(
        // Widens the tap target without moving the glyph.
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Icon(
              unread > 0
                  ? Icons.notifications_rounded
                  : Icons.notifications_none_rounded,
              size: size,
              color: color,
            ),
            if (unread > 0)
              Positioned(
                right: -5,
                top: -4,
                child: _Badge(count: unread),
              ),
          ],
        ),
      ),
    );
  }
}

/// The number itself.
///
/// Caps at 99+ because the badge has to stay a badge: an unbounded count
/// grows the pill until it covers the icon it is attached to.
class _Badge extends StatelessWidget {
  const _Badge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    final label = count > 99 ? '99+' : '$count';
    return Container(
      constraints: const BoxConstraints(minWidth: 16),
      height: 16,
      padding: EdgeInsets.symmetric(horizontal: label.length > 1 ? 4 : 0),
      decoration: BoxDecoration(
        color: AppColors.dangerFg,
        borderRadius: BorderRadius.circular(AppRadii.pill),
        // A ring in the surface colour, so the badge reads as separate from
        // the icon underneath rather than merging into it.
        border: Border.all(color: AppColors.white, width: 1.5),
      ),
      alignment: Alignment.center,
      child: Text(
        label,
        style: AppText.micro(AppColors.white).copyWith(
          fontSize: 9.5,
          fontWeight: FontWeight.w700,
          height: 1,
        ),
      ),
    );
  }
}
