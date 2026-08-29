/// Render what we already have, refresh behind it.
///
/// The API is roughly a second away — Supabase is in Tokyo and this is not —
/// and no amount of query tuning changes that. What it does change is whether
/// the user is made to *wait* for it.
///
/// Every provider used to be `autoDispose`, so leaving a tab threw its data
/// away and coming back refetched from nothing. Tapping Approvals meant a
/// spinner every single time, for data that had not changed since ten seconds
/// ago. Keeping the value and revalidating behind it means the screen is there
/// the instant you tap, and quietly corrects itself when the server answers.
///
/// This is stale-while-revalidate. The tradeoff is honest: you may see numbers
/// that are a few seconds old for a moment. For an approval queue that is the
/// right trade — the alternative is a blank screen, which is not more truthful,
/// only slower.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';


import '../theme/tokens.dart';

extension CachedAsyncValue<T> on AsyncValue<T> {
  /// True while a refresh is in flight over data we can already draw.
  bool get isRevalidating => isLoading && hasValue;

  /// Like `when`, but a reload over existing data keeps rendering that data.
  ///
  /// `loading` fires only on the FIRST load, when there is genuinely nothing
  /// to show. `error` likewise defers to cached data if we have any: a failed
  /// refresh should not blank a screen that was working a moment ago.
  R cachedWhen<R>({
    required R Function(T data) data,
    required R Function() loading,
    required R Function(Object error, StackTrace stack) error,
  }) {
    if (hasValue) return data(requireValue);
    if (hasError) return error(this.error!, stackTrace ?? StackTrace.empty);
    return loading();
  }
}

/// A hairline progress bar for a refresh happening over visible data.
///
/// Deliberately not a spinner over the content: the content is valid and
/// readable, and covering it would recreate the problem this exists to solve.
class RevalidatingBar extends StatelessWidget {
  const RevalidatingBar({super.key, required this.active});

  final bool active;

  @override
  Widget build(BuildContext context) => AnimatedOpacity(
        opacity: active ? 1 : 0,
        duration: const Duration(milliseconds: 180),
        child: SizedBox(
          height: 2,
          child: active
              ? const LinearProgressIndicator(
                  minHeight: 2,
                  backgroundColor: Colors.transparent,
                  valueColor: AlwaysStoppedAnimation(AppColors.glacier),
                )
              : null,
        ),
      );
}

/// Revalidates a provider when the widget it is attached to first appears.
///
/// Cached data is shown immediately; this is what makes sure it is not
/// cached data *forever*. Runs after the first frame so the screen paints
/// before any network work begins.
mixin RevalidateOnMount<T extends ConsumerStatefulWidget>
    on ConsumerState<T> {
  /// The providers to refresh when this screen appears.
  List<ProviderOrFamily> get revalidate;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      for (final provider in revalidate) {
        ref.invalidate(provider);
      }
    });
  }
}
