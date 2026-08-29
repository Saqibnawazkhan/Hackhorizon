/// Closing a purchase order.
///
/// The last step nobody builds. An order was approved, a supplier delivered,
/// and the record just... stopped, with the supplier's own `delivery_status`
/// as the only account of what happened.
///
/// This is the BUYER's account, and it is deliberately a separate fact. A
/// reliability score computed only from what a supplier says about their own
/// deliveries is not a measurement of anything. Closing records what was
/// actually received, by whom, and with what note.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../api/rfq_models.dart';
import '../state/providers.dart';
import '../theme/app_theme.dart';
import '../theme/surfaces.dart';
import '../theme/tokens.dart';
import 'common.dart';
import 'shell.dart';

/// The card shown on a closed order, in place of the close action.
class ClosedOrderCard extends StatelessWidget {
  const ClosedOrderCard({super.key, required this.order});

  final PurchaseOrder order;

  @override
  Widget build(BuildContext context) {
    final outcome = POClosureOutcome.fromWire(order.closureOutcome);
    final clean = outcome == POClosureOutcome.completed;

    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                clean ? Icons.task_alt : Icons.report_gmailerrorred_outlined,
                size: 18,
                color: clean ? AppColors.successFg : AppColors.warningFg,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  outcome?.label ?? 'Closed',
                  style: AppText.sectionTitle(),
                ),
              ),
              if (order.closedAt != null)
                Text(
                  '${order.closedAt!.day}/${order.closedAt!.month}/'
                  '${order.closedAt!.year}',
                  style: AppText.meta(),
                ),
            ],
          ),
          if (order.receivedQuantity != null) ...[
            const SizedBox(height: 8),
            MetaRow(
              label: 'Received',
              value: '${order.receivedQuantity} of ${order.totalUnits} units',
            ),
          ],
          if (order.closureNote != null && order.closureNote!.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('"${order.closureNote}"', style: AppText.explain()),
          ],
        ],
      ),
    );
  }
}

/// The close action itself.
Future<bool> showClosePurchaseOrder(
  BuildContext context,
  WidgetRef ref, {
  required String workflowId,
  required PurchaseOrder order,
}) async {
  final closed = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _CloseSheet(workflowId: workflowId, order: order),
  );
  return closed ?? false;
}

class _CloseSheet extends ConsumerStatefulWidget {
  const _CloseSheet({required this.workflowId, required this.order});

  final String workflowId;
  final PurchaseOrder order;

  @override
  ConsumerState<_CloseSheet> createState() => _CloseSheetState();
}

class _CloseSheetState extends ConsumerState<_CloseSheet> {
  POClosureOutcome _outcome = POClosureOutcome.completed;
  late final TextEditingController _note = TextEditingController();
  late final TextEditingController _received =
      TextEditingController(text: '${widget.order.totalUnits}');
  bool _busy = false;

  @override
  void dispose() {
    _note.dispose();
    _received.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    // The server refuses a blank note on anything but a clean completion.
    // Saying so here is better than letting it come back as a 422.
    if (_outcome.requiresNote && _note.text.trim().isEmpty) {
      showToast(
        context,
        'Say what went wrong — a note is required to close as '
        '${_outcome.label.toLowerCase()}.',
        danger: true,
      );
      return;
    }

    setState(() => _busy = true);
    HapticFeedback.mediumImpact();
    try {
      await ref.read(apiClientProvider).closePurchaseOrder(
            widget.workflowId,
            outcome: _outcome,
            note: _note.text.trim(),
            receivedQuantity: int.tryParse(_received.text),
          );
      ref.invalidate(purchaseOrderProvider(widget.workflowId));
      ref.invalidate(workflowDetailProvider(widget.workflowId));
      if (!mounted) return;
      Navigator.of(context).pop(true);
      showToast(context, 'Order closed as ${_outcome.label.toLowerCase()}');
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final order = widget.order;

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Container(
        decoration: const BoxDecoration(
          color: AppColors.white,
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(AppRadii.card),
          ),
        ),
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 38,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppColors.platinum,
                    borderRadius: BorderRadius.circular(AppRadii.pill),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text('Close ${order.poNumber}', style: AppText.pageTitle()),
              const SizedBox(height: 4),
              Text(
                'Your record of what actually arrived. Kept separate from the '
                'supplier\'s own delivery status, so the two can be compared.',
                style: AppText.explain(),
              ),

              const SizedBox(height: 18),
              Text('Outcome', style: AppText.captionStrong(AppColors.muted)),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final o in POClosureOutcome.values)
                    FilterChipButton(
                      label: o.label,
                      selected: _outcome == o,
                      onTap: () => setState(() => _outcome = o),
                    ),
                ],
              ),

              const SizedBox(height: 18),
              Text(
                'Units received',
                style: AppText.captionStrong(AppColors.muted),
              ),
              const SizedBox(height: 6),
              TextField(
                controller: _received,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  hintText: '${order.totalUnits} ordered',
                ),
              ),

              const SizedBox(height: 14),
              Text(
                _outcome.requiresNote ? 'Note (required)' : 'Note (optional)',
                style: AppText.captionStrong(AppColors.muted),
              ),
              const SizedBox(height: 6),
              TextField(
                controller: _note,
                maxLines: 3,
                decoration: InputDecoration(
                  hintText: switch (_outcome) {
                    POClosureOutcome.completed =>
                      'Anything worth recording…',
                    POClosureOutcome.completedWithIssues =>
                      'What was wrong? Short delivery, damage, late…',
                    POClosureOutcome.cancelled =>
                      'Why was this cancelled?',
                  },
                ),
              ),

              const SizedBox(height: 18),
              PrimaryButton(
                label: 'Close order',
                icon: Icons.task_alt,
                busy: _busy,
                onPressed: _submit,
              ),
              const SizedBox(height: 8),
              Text(
                'This cannot be undone.',
                style: AppText.meta(),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
