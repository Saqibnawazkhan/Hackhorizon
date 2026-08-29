/// The one sign-out control.
///
/// There were three near-copies of "an avatar in a header" and only one of
/// them was wired to anything. The home tab hides the shell header and draws
/// its own hero avatar, and the admin dashboard does the same, so on the
/// landing screen — the screen you are on when you want to switch accounts —
/// there was no way to sign out at all.
///
/// Everything that shows an avatar now uses this, so an inert one cannot be
/// reintroduced by adding another header.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../services/push.dart';
import '../state/providers.dart';
import '../theme/app_theme.dart';
import '../theme/tokens.dart';
import 'common.dart';

class SignOutAvatar extends ConsumerWidget {
  const SignOutAvatar({
    super.key,
    required this.initials,
    this.size = 42,
    this.note,
  });

  final String initials;
  final double size;

  /// Extra line in the confirmation, where a screen has unsaved state worth
  /// reassuring the user about.
  final String? note;

  @override
  Widget build(BuildContext context, WidgetRef ref) => GestureDetector(
    onTap: () => confirmSignOut(context, ref, note: note),
    // Without this the transparent padding around the circle swallows
    // nothing and the tap target stays the size of the drawn glyph.
    behavior: HitTestBehavior.opaque,
    child: AvatarCircle(initials: initials, size: size),
  );
}

/// Confirm, then end the session.
///
/// Shared so the shell, the two dashboards and the vendor portal cannot drift
/// apart on what signing out actually does.
Future<void> confirmSignOut(
  BuildContext context,
  WidgetRef ref, {
  String? note,
}) async {
  HapticFeedback.selectionClick();

  final out = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      backgroundColor: AppColors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadii.panel),
      ),
      title: Text('Sign out?', style: AppText.sectionTitle()),
      content: Text(
        note ?? 'You will need to sign in again to use AgentFlow.',
        style: AppText.body(),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(false),
          child: Text('Cancel', style: AppText.captionStrong(AppColors.muted)),
        ),
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(true),
          child: Text(
            'Sign out',
            style: AppText.captionStrong(AppColors.dangerFg),
          ),
        ),
      ],
    ),
  );
  if (out != true) return;

  // Started, not awaited: it needs the session that is about to end in order
  // to authenticate, but nothing should wait on it.
  PushService.instance.forget(ref.read(apiClientProvider));
  await ref.read(authProvider.notifier).signOut();
}
