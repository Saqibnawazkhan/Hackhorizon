/// Screens 13a and 15a -- vendors list, and catalog browse.
///
/// 13a: employees can view vendors and add one, which lands PENDING for an
/// admin to verify. The reliability figure is real fulfilment history or the
/// words "No history yet" -- never a decorative star.
/// 15a: browse published catalog items with live prices and stock.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../state/cached.dart';

class VendorsScreen extends ConsumerWidget {
  const VendorsScreen({super.key, this.embedded = false});

  final bool embedded;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final vendors = ref.watch(vendorListProvider(null));

    final body = vendors.cachedWhen(
      loading: () => const LoadingState(),
      error: (e, _) => ErrorState(
        message: '$e',
        onRetry: () => ref.invalidate(vendorListProvider(null)),
      ),
      data: (page) => RefreshIndicator(
        color: AppColors.turquoise,
        onRefresh: () async => ref.refresh(vendorListProvider(null).future),
        child: ListView(
          padding: const EdgeInsets.only(bottom: 24),
          children: [
            for (final v in page.items) ...[
              _VendorCard(
                vendor: v,
                onBrowse: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => CatalogBrowseScreen(vendor: v),
                  ),
                ),
              ),
              const SizedBox(height: 10),
            ],
            const SizedBox(height: 4),
            SecondaryButton(
              label: 'Add a vendor',
              icon: Icons.add,
              onPressed: () => _addVendor(context, ref),
            ),
            const SizedBox(height: 8),
            Text(
              'Vendors you add start as Pending. An administrator verifies '
              'them before the agent will quote from their catalog.',
              style: AppText.meta(),
            ),
          ],
        ),
      ),
    );

    if (embedded) return body;
    return AppScaffold(
      header: const AppHeader(title: 'Vendors', subtitle: 'Suppliers on record'),
      child: body,
    );
  }

  Future<void> _addVendor(BuildContext context, WidgetRef ref) async {
    final name = TextEditingController();
    final email = TextEditingController();
    final category = TextEditingController();

    final created = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(ctx).bottom,
        ),
        child: Container(
          decoration: const BoxDecoration(
            color: AppColors.white,
            borderRadius: BorderRadius.vertical(
              top: Radius.circular(AppRadii.card),
            ),
          ),
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppColors.divider,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text('Add a vendor', style: AppText.sectionTitle()),
              const SizedBox(height: 14),
              TextField(
                controller: name,
                decoration: const InputDecoration(hintText: 'Vendor name'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: email,
                decoration: const InputDecoration(hintText: 'Email (optional)'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: category,
                decoration:
                    const InputDecoration(hintText: 'Category (optional)'),
              ),
              const SizedBox(height: 18),
              PrimaryButton(
                label: 'Submit for verification',
                onPressed: () => Navigator.of(ctx).pop(true),
              ),
              const SizedBox(height: 12),
            ],
          ),
        ),
      ),
    );

    if (created != true || name.text.trim().isEmpty) return;
    if (!context.mounted) return;
    try {
      await ref.read(apiClientProvider).createVendor(
            name: name.text.trim(),
            email: email.text.trim().isEmpty ? null : email.text.trim(),
            category:
                category.text.trim().isEmpty ? null : category.text.trim(),
          );
      ref.invalidate(vendorListProvider(null));
      if (context.mounted) {
        showToast(context, 'Vendor submitted — awaiting admin verification');
      }
    } on ApiException catch (e) {
      if (context.mounted) showToast(context, e.message, danger: true);
    }
  }
}

class _VendorCard extends StatelessWidget {
  const _VendorCard({required this.vendor, this.onBrowse});

  final Vendor vendor;
  final VoidCallback? onBrowse;

  @override
  Widget build(BuildContext context) => GlassCard(
        onTap: onBrowse,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(vendor.name, style: AppText.sectionTitle()),
                ),
                StatusPill.forVendor(vendor.status),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                if (vendor.reliability.hasHistory) ...[
                  const Icon(
                    Icons.star_rounded,
                    size: 14,
                    color: AppColors.warningFg,
                  ),
                  const SizedBox(width: 3),
                  Text(
                    vendor.reliability.display,
                    style: AppText.captionStrong(AppColors.warningFg),
                  ),
                  Text(
                    '  ·  ${vendor.reliability.ordersFulfilled} orders',
                    style: AppText.meta(),
                  ),
                ] else
                  Text(
                    'No history yet',
                    style: AppText.meta(AppColors.subtle),
                  ),
                const Spacer(),
                if (vendor.category != null)
                  Text(vendor.category!, style: AppText.meta()),
              ],
            ),
            // The monitoring job's flag, surfaced rather than buried.
            if (vendor.isFlagged) ...[
              const SizedBox(height: 10),
              for (final f in vendor.flags)
                Row(
                  children: [
                    const Icon(
                      Icons.flag,
                      size: 12,
                      color: AppColors.dangerFg,
                    ),
                    const SizedBox(width: 5),
                    Expanded(
                      child: Text(
                        f.detail,
                        style: AppText.meta(AppColors.dangerFg),
                      ),
                    ),
                  ],
                ),
            ],
          ],
        ),
      );
}

// ===========================================================================
// Screen 15a -- catalog browse
// ===========================================================================
class CatalogBrowseScreen extends ConsumerStatefulWidget {
  const CatalogBrowseScreen({super.key, this.vendor});

  final Vendor? vendor;

  @override
  ConsumerState<CatalogBrowseScreen> createState() =>
      _CatalogBrowseScreenState();
}

class _CatalogBrowseScreenState extends ConsumerState<CatalogBrowseScreen> {
  String _search = '';

  @override
  Widget build(BuildContext context) {
    final items = ref.watch(catalogBrowseProvider(_search.isEmpty ? null : _search));

    return AppScaffold(
      header: AppHeader(
        title: widget.vendor?.name ?? 'Vendor Catalog',
        subtitle: 'Live pricing and stock',
      ),
      child: Column(
        children: [
          TextField(
            decoration: const InputDecoration(
              hintText: 'Search items…',
              prefixIcon: Icon(Icons.search, size: 19, color: AppColors.subtle),
            ),
            onChanged: (v) => setState(() => _search = v),
          ),
          const SizedBox(height: 12),
          Expanded(
            child: items.cachedWhen(
              loading: () => const LoadingState(),
              error: (e, _) => ErrorState(message: '$e'),
              data: (list) {
                final filtered = widget.vendor == null
                    ? list
                    : list.where((i) => i.vendorId == widget.vendor!.id).toList();
                if (filtered.isEmpty) {
                  return const EmptyState(
                    title: 'No items',
                    message: 'Nothing published matches your search.',
                    icon: Icons.inventory_2_outlined,
                  );
                }
                return ListView.separated(
                  padding: const EdgeInsets.only(bottom: 24),
                  itemCount: filtered.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 8),
                  itemBuilder: (_, i) => _ItemCard(item: filtered[i]),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _ItemCard extends StatelessWidget {
  const _ItemCard({required this.item});

  final CatalogItem item;

  @override
  Widget build(BuildContext context) => GlassCard(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(item.title, style: AppText.listTitle()),
                  if (item.description != null)
                    Text(item.description!, style: AppText.meta()),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      if (item.vendorName != null) ...[
                        Text(item.vendorName!, style: AppText.micro(AppColors.turquoise)),
                        Text('  ·  ', style: AppText.micro()),
                      ],
                      Text('${item.stock} in stock', style: AppText.micro()),
                      if (item.isLowStock) ...[
                        const SizedBox(width: 6),
                        const StatusPill(
                          label: 'Low stock',
                          tone: PillTone.neutral,
                          showDot: false,
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  formatMoney(item.effectivePrice, item.currency),
                  style: AppText.listTitle(AppColors.turquoise),
                ),
                const SizedBox(height: 2),
                Text(
                  [
                    if (item.deliveryDays != null) '${item.deliveryDays}d',
                    if (item.warrantyMonths != null)
                      formatWarranty(item.warrantyMonths),
                  ].join(' · '),
                  style: AppText.micro(),
                ),
              ],
            ),
          ],
        ),
      );
}
