/// A supplier's quote requests, and the form for answering one.
///
/// A buyer's agent looked for something and found nothing any vendor had
/// listed. Rather than the request dying there, every verified vendor is asked
/// directly. Answering publishes the quoted lines into the catalog, and the
/// buyer's re-run then finds them through the ordinary path.
///
/// A supplier never sees another supplier's answer. The server returns only
/// this vendor's own row, and the RLS policy enforces it again underneath —
/// the isolation is not a property of this screen.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/rfq_models.dart';
import '../../state/cached.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';

class QuoteRequestsScreen extends ConsumerWidget {
  const QuoteRequestsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final requests = ref.watch(myQuoteRequestsProvider);

    return AppScaffold(
      header: const AppHeader(
        title: 'Quote requests',
        subtitle: 'Buyers asking for something you may stock',
      ),
      child: requests.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(myQuoteRequestsProvider),
        ),
        data: (items) => items.isEmpty
            ? const EmptyState(
                icon: Icons.mark_email_read_outlined,
                title: 'Nothing to quote',
                message: 'When a buyer needs something no one has listed, '
                    'you will be asked here.',
              )
            : RefreshIndicator(
                color: AppColors.turquoise,
                onRefresh: () async {
                  ref.invalidate(openQuoteCountProvider);
                  return ref.refresh(myQuoteRequestsProvider.future);
                },
                child: ListView.separated(
                  padding: const EdgeInsets.only(bottom: 24),
                  itemCount: items.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 10),
                  itemBuilder: (_, i) => _RequestCard(request: items[i]),
                ),
              ),
      ),
    );
  }
}

class _RequestCard extends ConsumerWidget {
  const _RequestCard({required this.request});

  final QuoteRequest request;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mine = request.myResponse;
    final answered = mine != null && !mine.isWaiting;

    return GlassCard(
      onTap: answered || !request.isOpen
          ? null
          : () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => RespondToQuoteScreen(request: request),
                ),
              ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  request.workflowTitle ?? 'Buyer request',
                  style: AppText.listTitle(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              StatusPill(
                label: answered
                    ? mine.statusLabel
                    : request.deadlineLabel ?? 'Open',
                tone: answered
                    ? (mine.hasDeclined ? PillTone.neutral : PillTone.success)
                    : (request.isExpired ? PillTone.warning : PillTone.info),
                showDot: false,
              ),
            ],
          ),

          // What the buyer was trying to buy, and why it failed.
          if (request.reason != null && request.reason!.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(request.reason!, style: AppText.meta()),
          ],
          if (request.note != null && request.note!.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text('"${request.note}"', style: AppText.explain()),
          ],

          const SizedBox(height: 10),
          for (final item in request.items)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.inventory_2_outlined,
                    size: 13,
                    color: AppColors.subtle,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      [
                        item.line,
                        if (item.specification != null &&
                            item.specification!.isNotEmpty)
                          item.specification!,
                      ].join(' · '),
                      style: AppText.meta(),
                    ),
                  ),
                ],
              ),
            ),

          if (request.budget != null) ...[
            const SizedBox(height: 6),
            Text(
              'Budget ${formatMoney(request.budget, request.currency)}',
              style: AppText.captionStrong(AppColors.turquoise),
            ),
          ],

          const SizedBox(height: 12),
          if (answered)
            Text(
              mine.hasDeclined
                  ? 'You declined this request.'
                  : mine.publishedToCatalog
                      ? 'Quoted — your items are live in the buyer\'s search.'
                      : 'Quoted, but nothing was published, so the agent '
                          'cannot consider it.',
              style: AppText.meta(
                mine.hasDeclined || !mine.publishedToCatalog
                    ? AppColors.warningFg
                    : AppColors.successFg,
              ),
            )
          else if (!request.isOpen)
            Text('This request has closed.', style: AppText.meta())
          else
            Row(
              children: [
                Expanded(
                  child: PrimaryButton(
                    label: 'Quote',
                    icon: Icons.request_quote_outlined,
                    height: 44,
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => RespondToQuoteScreen(request: request),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: SecondaryButton(
                    label: 'Decline',
                    height: 44,
                    onPressed: () => _decline(context, ref),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }

  Future<void> _decline(BuildContext context, WidgetRef ref) async {
    final reason = await showDialog<String?>(
      context: context,
      builder: (_) => const _DeclineDialog(),
    );
    if (reason == null) return;
    try {
      await ref
          .read(apiClientProvider)
          .declineQuoteRequest(request.id, reason: reason);
      ref.invalidate(myQuoteRequestsProvider);
      ref.invalidate(openQuoteCountProvider);
      if (context.mounted) showToast(context, 'Declined');
    } on ApiException catch (e) {
      if (context.mounted) showToast(context, e.message, danger: true);
    }
  }
}

class _DeclineDialog extends StatefulWidget {
  const _DeclineDialog();

  @override
  State<_DeclineDialog> createState() => _DeclineDialogState();
}

class _DeclineDialogState extends State<_DeclineDialog> {
  final _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        backgroundColor: AppColors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.panel),
        ),
        title: Text('Decline this request?', style: AppText.sectionTitle()),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'The buyer sees that you replied rather than ignored it, which '
              'is worth more than silence.',
              style: AppText.body(),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _reason,
              decoration: const InputDecoration(
                hintText: 'Reason (optional)',
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
            onPressed: () => Navigator.of(context).pop(_reason.text.trim()),
            child: Text(
              'Decline',
              style: AppText.captionStrong(AppColors.dangerFg),
            ),
          ),
        ],
      );
}

// ===========================================================================
// The reply form
// ===========================================================================
class RespondToQuoteScreen extends ConsumerStatefulWidget {
  const RespondToQuoteScreen({super.key, required this.request});

  final QuoteRequest request;

  @override
  ConsumerState<RespondToQuoteScreen> createState() =>
      _RespondToQuoteScreenState();
}

class _RespondToQuoteScreenState extends ConsumerState<RespondToQuoteScreen> {
  /// One editable row per requested item, keyed by item name — which is also
  /// what the server matches on when it publishes into the catalog.
  late final Map<String, _LineDraft> _drafts = {
    for (final item in widget.request.items)
      item.name: _LineDraft(
        title: item.name,
        // The buyer's quantity is the sensible default: absent a figure the
        // server publishes stock equal to what was asked for anyway.
        quantity: item.quantity,
      ),
  };

  final _note = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    for (final d in _drafts.values) {
      d.dispose();
    }
    _note.dispose();
    super.dispose();
  }

  bool get _anyAvailable => _drafts.values.any((d) => d.available);

  bool get _priced => _drafts.values
      .where((d) => d.available)
      .every((d) => d.unitPrice != null && d.sku.text.trim().isNotEmpty);

  Future<void> _submit() async {
    if (!_anyAvailable) {
      showToast(
        context,
        'Mark at least one item available, or decline the request.',
        danger: true,
      );
      return;
    }
    if (!_priced) {
      showToast(
        context,
        'Every available item needs a SKU and a unit price.',
        danger: true,
      );
      return;
    }

    setState(() => _busy = true);
    HapticFeedback.mediumImpact();
    try {
      final result = await ref.read(apiClientProvider).respondToQuoteRequest(
            widget.request.id,
            lines: [
              for (final entry in _drafts.entries)
                entry.value.toLine(entry.key),
            ],
            note: _note.text.trim(),
          );
      ref.invalidate(myQuoteRequestsProvider);
      ref.invalidate(openQuoteCountProvider);
      ref.invalidate(myCatalogProvider);
      if (!mounted) return;
      Navigator.of(context).pop();
      showToast(context, result.detail);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final request = widget.request;

    return AppScaffold(
      header: AppHeader(
        title: 'Quote',
        subtitle: request.workflowTitle ?? 'Buyer request',
      ),
      footer: PrimaryButton(
        label: 'Send quote',
        icon: Icons.send_outlined,
        busy: _busy,
        onPressed: _submit,
      ),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 16),
        children: [
          InfoBanner(
            title: 'What you quote goes live',
            message: 'Priced items are published to your catalog immediately, '
                'so the buyer\'s agent can compare them against everyone '
                'else. Nothing is committed until they approve an order.',
            tone: PillTone.info,
            icon: Icons.published_with_changes_outlined,
          ),
          if (request.budget != null) ...[
            const SizedBox(height: 12),
            MutedSurface(
              borderColor: AppColors.platinum,
              child: Row(
                children: [
                  const Icon(
                    Icons.account_balance_wallet_outlined,
                    size: 15,
                    color: AppColors.muted,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'The buyer\'s budget is '
                      '${formatMoney(request.budget, request.currency)} for '
                      'the whole request.',
                      style: AppText.meta(),
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 16),
          for (final item in request.items) ...[
            _LineEditor(
              item: item,
              draft: _drafts[item.name]!,
              currency: request.currency,
              onChanged: () => setState(() {}),
            ),
            const SizedBox(height: 10),
          ],
          GlassCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Note to the buyer', style: AppText.listTitle()),
                const SizedBox(height: 8),
                TextField(
                  controller: _note,
                  maxLines: 2,
                  decoration: const InputDecoration(
                    hintText: 'Lead times, alternatives, anything else…',
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The editable state of one quoted line.
class _LineDraft {
  _LineDraft({required String title, required int quantity})
      : title = TextEditingController(text: title),
        quantity = TextEditingController(text: '$quantity');

  bool available = true;
  final TextEditingController title;
  final TextEditingController sku = TextEditingController();
  final TextEditingController price = TextEditingController();
  final TextEditingController quantity;
  final TextEditingController delivery = TextEditingController();
  final TextEditingController warranty = TextEditingController();

  double? get unitPrice => double.tryParse(price.text.replaceAll(',', ''));

  QuoteResponseLine toLine(String requestItemName) => QuoteResponseLine(
        requestItemName: requestItemName,
        available: available,
        sku: available ? sku.text.trim() : null,
        title: available ? title.text.trim() : null,
        unitPrice: available ? unitPrice : null,
        quantity: available ? int.tryParse(quantity.text) : null,
        deliveryDays: available ? int.tryParse(delivery.text) : null,
        warrantyMonths: available ? int.tryParse(warranty.text) : null,
      );

  void dispose() {
    for (final c in [title, sku, price, quantity, delivery, warranty]) {
      c.dispose();
    }
  }
}

class _LineEditor extends StatelessWidget {
  const _LineEditor({
    required this.item,
    required this.draft,
    required this.currency,
    required this.onChanged,
  });

  final QuoteRequestItem item;
  final _LineDraft draft;
  final String currency;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) => GlassCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(item.name, style: AppText.listTitle()),
                      const SizedBox(height: 2),
                      Text(
                        [
                          'They want ${item.line}',
                          if (item.specification != null &&
                              item.specification!.isNotEmpty)
                            item.specification!,
                        ].join(' · '),
                        style: AppText.meta(),
                      ),
                    ],
                  ),
                ),
                Switch(
                  value: draft.available,
                  activeThumbColor: AppColors.turquoise,
                  onChanged: (v) {
                    draft.available = v;
                    onChanged();
                  },
                ),
              ],
            ),
            if (!draft.available)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  'Marked as unavailable. Nothing is published for this item.',
                  style: AppText.meta(),
                ),
              )
            else ...[
              const SizedBox(height: 12),
              _field('What you would supply', draft.title),
              _field('SKU', draft.sku, hint: 'Your own item code'),
              Row(
                children: [
                  Expanded(
                    child: _field(
                      'Unit price ($currency)',
                      draft.price,
                      number: true,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _field('Stock', draft.quantity, number: true),
                  ),
                ],
              ),
              Row(
                children: [
                  Expanded(
                    child: _field(
                      'Delivery (days)',
                      draft.delivery,
                      number: true,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _field(
                      'Warranty (months)',
                      draft.warranty,
                      number: true,
                    ),
                  ),
                ],
              ),
              Text(
                'Delivery and warranty are what the agent scores you on '
                'besides price. Leaving them blank costs you points.',
                style: AppText.meta(),
              ),
            ],
          ],
        ),
      );

  Widget _field(
    String label,
    TextEditingController controller, {
    String? hint,
    bool number = false,
  }) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: AppText.captionStrong(AppColors.muted)),
            const SizedBox(height: 5),
            TextField(
              controller: controller,
              keyboardType: number ? TextInputType.number : TextInputType.text,
              decoration: InputDecoration(hintText: hint),
            ),
          ],
        ),
      );
}
