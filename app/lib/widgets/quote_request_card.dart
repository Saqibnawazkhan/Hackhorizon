/// The escalation card: what a buyer can do when the agent found nothing.
///
/// "No supplier in the category matches this request" used to be the end of
/// the road — the run stopped and the screen offered nothing but the reason.
/// The gap is usually not that no vendor CAN supply it; it is that nobody has
/// listed it. So the buyer asks.
///
/// The loop closes without touching the agent. A vendor's answer publishes
/// into the catalog as an ordinary item, and re-running the same workflow
/// finds it through the path the agent already uses. That is why the button
/// at the end says "Run again" rather than "Use these quotes": there is no
/// separate quote-consuming path to build, and there should not be one.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../api/rfq_models.dart';
import '../state/providers.dart';
import '../theme/app_theme.dart';
import '../theme/surfaces.dart';
import '../theme/tokens.dart';
import 'common.dart';
import 'shell.dart';

class QuoteRequestCard extends ConsumerStatefulWidget {
  const QuoteRequestCard({
    super.key,
    required this.workflowId,
    required this.escalationReason,
  });

  final String workflowId;
  final String escalationReason;

  @override
  ConsumerState<QuoteRequestCard> createState() => _QuoteRequestCardState();
}

class _QuoteRequestCardState extends ConsumerState<QuoteRequestCard> {
  bool _busy = false;

  Future<void> _ask() async {
    final note = await showDialog<String?>(
      context: context,
      builder: (_) => const _AskDialog(),
    );
    if (note == null) return; // cancelled

    setState(() => _busy = true);
    try {
      final request = await ref
          .read(apiClientProvider)
          .createQuoteRequest(widget.workflowId, note: note.isEmpty ? null : note);
      ref.invalidate(workflowQuoteRequestProvider(widget.workflowId));
      if (!mounted) return;
      setState(() => _busy = false);
      showToast(
        context,
        'Asked ${request.invitedCount} '
        '${request.invitedCount == 1 ? 'supplier' : 'suppliers'} to quote',
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      showToast(context, e.message, danger: true);
    }
  }

  Future<void> _rerun() async {
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).runWorkflow(widget.workflowId);
      ref.invalidate(workflowDetailProvider(widget.workflowId));
      ref.invalidate(workflowQuoteRequestProvider(widget.workflowId));
      if (!mounted) return;
      setState(() => _busy = false);
      showToast(context, 'Running again with the new quotes');
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final existing = ref.watch(workflowQuoteRequestProvider(widget.workflowId));

    return existing.when(
      // The card is secondary to the escalation banner above it, so a slow
      // lookup shows nothing rather than a spinner competing for attention.
      loading: () => const SizedBox.shrink(),
      error: (_, __) => const SizedBox.shrink(),
      data: (request) => request == null
          ? _Offer(busy: _busy, onAsk: _ask)
          : _Status(
              request: request,
              busy: _busy,
              onRerun: request.isActionable ? _rerun : null,
              onAskAgain: request.isOpen ? null : _ask,
            ),
    );
  }
}

/// Nothing asked yet.
class _Offer extends StatelessWidget {
  const _Offer({required this.busy, required this.onAsk});

  final bool busy;
  final VoidCallback onAsk;

  @override
  Widget build(BuildContext context) => GlassCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.campaign_outlined,
                  size: 18,
                  color: AppColors.turquoise,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Ask your suppliers',
                    style: AppText.sectionTitle(),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              'Nothing in the catalog matched. That usually means nobody has '
              'listed it yet, not that nobody can supply it — so ask every '
              'verified vendor to quote.',
              style: AppText.explain(),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: PrimaryButton(
                label: 'Request quotes from vendors',
                icon: Icons.send_outlined,
                height: 46,
                busy: busy,
                onPressed: onAsk,
              ),
            ),
          ],
        ),
      );
}

/// A request is out. Show who has answered.
class _Status extends StatelessWidget {
  const _Status({
    required this.request,
    required this.busy,
    required this.onRerun,
    required this.onAskAgain,
  });

  final QuoteRequest request;
  final bool busy;
  final VoidCallback? onRerun;
  final VoidCallback? onAskAgain;

  @override
  Widget build(BuildContext context) {
    final deadline = request.deadlineLabel;
    return GlassCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Quotes requested', style: AppText.sectionTitle()),
                      const SizedBox(height: 3),
                      Text(request.summaryLine, style: AppText.meta()),
                    ],
                  ),
                ),
                StatusPill(
                  label: switch (request.status) {
                    'open' => deadline ?? 'Open',
                    'closed' => 'Closed',
                    'expired' => 'Expired',
                    _ => request.status,
                  },
                  tone: request.isOpen
                      ? PillTone.info
                      : request.isExpired
                          ? PillTone.warning
                          : PillTone.neutral,
                  showDot: false,
                ),
              ],
            ),
          ),
          const HairLine(),

          // One row per invited vendor. A vendor that has said nothing is
          // still shown -- silence is the answer the buyer most needs to see.
          for (final r in request.responses) ...[
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: 16,
                vertical: 10,
              ),
              child: _ResponseRow(response: r, currency: request.currency),
            ),
            const HairLine(),
          ],

          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (onRerun != null) ...[
                  PrimaryButton(
                    label: 'Run again with these quotes',
                    icon: Icons.refresh,
                    height: 46,
                    busy: busy,
                    onPressed: onRerun,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Quoted items are published into the catalog, so the agent '
                    'compares them exactly like any other supplier.',
                    style: AppText.meta(),
                    textAlign: TextAlign.center,
                  ),
                ] else if (request.isOpen) ...[
                  Text(
                    request.respondedCount == 0
                        ? 'Waiting for the first reply.'
                        : 'Replies received, but none published a price yet.',
                    style: AppText.meta(),
                    textAlign: TextAlign.center,
                  ),
                ] else if (onAskAgain != null) ...[
                  SecondaryButton(
                    label: 'Ask again',
                    icon: Icons.campaign_outlined,
                    height: 44,
                    onPressed: busy ? null : onAskAgain,
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

class _ResponseRow extends StatelessWidget {
  const _ResponseRow({required this.response, required this.currency});

  final QuoteResponse response;
  final String currency;

  @override
  Widget build(BuildContext context) {
    final r = response;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                r.vendorName ?? 'Supplier',
                style: AppText.listTitleSm(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 2),
              Text(
                switch (r.status) {
                  'responded' => [
                      if (r.totalAmount != null)
                        formatMoney(r.totalAmount, r.currency ?? currency),
                      if (r.deliveryDays != null) '${r.deliveryDays}d delivery',
                      if (!r.publishedToCatalog) 'not published',
                    ].join(' · '),
                  'declined' => r.declineReason?.isNotEmpty == true
                      ? 'Declined — ${r.declineReason}'
                      : 'Declined',
                  _ => 'No reply yet',
                },
                style: AppText.meta(),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        StatusPill(
          label: r.statusLabel,
          tone: switch (r.status) {
            'responded' =>
              r.publishedToCatalog ? PillTone.success : PillTone.warning,
            'declined' => PillTone.danger,
            _ => PillTone.neutral,
          },
          showDot: false,
          dense: true,
        ),
      ],
    );
  }
}

/// Optional note to the suppliers.
class _AskDialog extends StatefulWidget {
  const _AskDialog();

  @override
  State<_AskDialog> createState() => _AskDialogState();
}

class _AskDialogState extends State<_AskDialog> {
  final _note = TextEditingController();

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        backgroundColor: AppColors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.panel),
        ),
        title: Text('Request quotes', style: AppText.sectionTitle()),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Every verified vendor will be notified with the items you '
              'asked for and your budget. They have 48 hours to reply.',
              style: AppText.body(),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _note,
              maxLines: 2,
              decoration: const InputDecoration(
                hintText: 'Anything to add? (optional)',
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text('Cancel', style: AppText.captionStrong(AppColors.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(_note.text.trim()),
            child: Text(
              'Send request',
              style: AppText.captionStrong(AppColors.turquoise),
            ),
          ),
        ],
      );
}
