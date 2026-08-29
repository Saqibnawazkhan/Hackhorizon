/// Screen 7a -- Purchase Order preview.
///
/// The PO references the QUOTE SNAPSHOT, not the live catalog, so what is
/// shown here cannot drift if a vendor republishes mid-run. The provenance
/// note makes that explicit rather than leaving it implied.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../widgets/pdf_link.dart';
import '../../state/cached.dart';
import '../../widgets/close_po_sheet.dart';

class PurchaseOrderScreen extends ConsumerWidget {
  const PurchaseOrderScreen({super.key, required this.workflowId});

  final String workflowId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final po = ref.watch(purchaseOrderProvider(workflowId));

    return AppScaffold(
      header: AppHeader(
        title: 'Purchase Order',
        subtitle: po.valueOrNull?.poNumber,
        trailing: po.valueOrNull == null
            ? null
            : StatusPill(
                label: po.value!.deliveryStatus.label,
                tone: PillTone.info,
              ),
      ),
      child: po.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(purchaseOrderProvider(workflowId)),
        ),
        data: (order) => ListView(
          padding: const EdgeInsets.only(bottom: 24),
          children: [
            GlassCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('PURCHASE ORDER', style: AppText.micro()),
                            const SizedBox(height: 2),
                            Text(order.poNumber, style: AppText.pageTitle()),
                          ],
                        ),
                      ),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text('Total', style: AppText.micro()),
                          Text(
                            formatMoney(order.totalAmount, order.currency),
                            style: AppText.sectionTitle(AppColors.turquoise),
                          ),
                        ],
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  const HairLine(),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 24,
                    runSpacing: 10,
                    children: [
                      _term(
                        'Delivery',
                        order.deliveryDays == null
                            ? '—'
                            : '${order.deliveryDays} days',
                      ),
                      _term('Warranty', formatWarranty(order.warrantyMonths)),
                      if (order.expectedDeliveryDate != null)
                        _term(
                          'Expected',
                          '${order.expectedDeliveryDate!.day}/'
                              '${order.expectedDeliveryDate!.month}/'
                              '${order.expectedDeliveryDate!.year}',
                        ),
                      if (order.paymentTerms != null)
                        _term('Payment', order.paymentTerms!),
                      _term('Attempt', '${order.generationAttempt}'),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),

            GlassCard(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Line items', style: AppText.sectionTitle()),
                  const SizedBox(height: 10),
                  for (final li in order.lineItems) ...[
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(
                          width: 18,
                          child: Text(
                            '${li.lineNumber}.',
                            style: AppText.meta(),
                          ),
                        ),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(li.description, style: AppText.listTitle()),
                              Text(
                                '${li.quantity} × '
                                '${formatMoney(li.unitPrice, order.currency)}'
                                '${li.sku != null ? '  ·  ${li.sku}' : ''}',
                                style: AppText.meta(),
                              ),
                            ],
                          ),
                        ),
                        Text(
                          formatMoney(li.lineTotal, order.currency),
                          style: AppText.captionStrong(),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                  ],
                  const HairLine(),
                  const SizedBox(height: 10),
                  _totalRow('Subtotal', order.subtotal, order.currency),
                  _totalRow('Tax', order.tax, order.currency),
                  const SizedBox(height: 4),
                  _totalRow(
                    'Total',
                    order.totalAmount,
                    order.currency,
                    emphasis: true,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),

            const InfoBanner(
              message:
                  'Priced from the supplier quote snapshot taken at comparison '
                  'time. Later catalog changes cannot alter this order.',
              tone: PillTone.info,
              icon: Icons.lock_outline,
            ),

            const SizedBox(height: 12),
            PdfButton(pdfUrl: order.pdfUrl),

            // Close-out. An approved order that was delivered used to just
            // stop here, leaving the supplier's own delivery status as the
            // only account of what happened.
            const SizedBox(height: 12),
            if (order.isClosed)
              ClosedOrderCard(order: order)
            else
              SizedBox(
                width: double.infinity,
                child: SecondaryButton(
                  label: 'Close this order',
                  icon: Icons.task_alt,
                  height: 46,
                  onPressed: () => showClosePurchaseOrder(
                    context,
                    ref,
                    workflowId: workflowId,
                    order: order,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _term(String label, String value) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label, style: AppText.micro()),
          const SizedBox(height: 2),
          Text(value, style: AppText.captionStrong()),
        ],
      );

  Widget _totalRow(
    String label,
    double value,
    String currency, {
    bool emphasis = false,
  }) =>
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          children: [
            Expanded(
              child: Text(
                label,
                style: emphasis
                    ? AppText.sectionTitle(AppColors.turquoise)
                    : AppText.caption(),
              ),
            ),
            Text(
              formatMoney(value, currency),
              style: emphasis
                  ? AppText.sectionTitle(AppColors.turquoise)
                  : AppText.captionStrong(),
            ),
          ],
        ),
      );
}
