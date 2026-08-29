/// Vendor portal: 14a/14d (price and stock), 14b (add item), 14c (published),
/// plus the incoming-PO and delivery-status screen the design does not include.
///
/// TREATMENT: 14d is 14a redrawn in claymorphism. Both are implemented and
/// switchable at runtime, because the design offers both without saying which
/// ships -- the toggle is in the header, and clay is the default since it is
/// the later riff.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import 'connections_screen.dart';
import 'import_screen.dart';
import '../../widgets/sign_out.dart';
import '../../widgets/pdf_link.dart';
import '../../widgets/notification_bell.dart';
import '../../state/cached.dart';
import 'quote_requests_screen.dart';

/// Whether the vendor portal renders in clay (14d) or glass (14a).
final vendorClayProvider = StateProvider<bool>((ref) => true);

class VendorPortalScreen extends ConsumerStatefulWidget {
  const VendorPortalScreen({super.key});

  @override
  ConsumerState<VendorPortalScreen> createState() => _VendorPortalScreenState();
}

class _VendorPortalScreenState extends ConsumerState<VendorPortalScreen> {
  final Map<String, double> _pendingPrice = {};
  final Map<String, int> _pendingStock = {};
  bool _publishing = false;

  Future<void> _publish() async {
    setState(() => _publishing = true);
    try {
      // Flush inline edits before publishing, so nothing is silently dropped.
      for (final entry in _pendingPrice.entries) {
        await ref
            .read(apiClientProvider)
            .updateCatalogItem(entry.key, price: entry.value);
      }
      for (final entry in _pendingStock.entries) {
        await ref
            .read(apiClientProvider)
            .updateCatalogItem(entry.key, stock: entry.value);
      }
      final result = await ref.read(apiClientProvider).publishCatalog();
      _pendingPrice.clear();
      _pendingStock.clear();
      ref.invalidate(myCatalogProvider);
      if (!mounted) return;
      setState(() => _publishing = false);
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => ItemPublishedScreen(
            count: (result['published_count'] as num?)?.toInt() ?? 0,
          ),
        ),
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _publishing = false);
      showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final clay = ref.watch(vendorClayProvider);
    final catalog = ref.watch(myCatalogProvider);
    final user = ref.watch(currentUserProvider);

    final dirty = _pendingPrice.length + _pendingStock.length;

    return AppScaffold(
      vendor: clay,
      header: Padding(
        padding: const EdgeInsets.fromLTRB(20, 6, 20, 10),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Vendor Portal', style: AppText.pageTitle()),
                  Text(
                    '${user?.displayName ?? 'Vendor'} · signed in as vendor',
                    style: AppText.caption(),
                  ),
                ],
              ),
            ),
            // The 14a / 14d treatment switch.
            IconButton(
              tooltip: clay ? 'Switch to liquid glass' : 'Switch to clay',
              icon: Icon(
                clay ? Icons.blur_on : Icons.layers_outlined,
                size: 20,
                color: AppColors.turquoise,
              ),
              onPressed: () =>
                  ref.read(vendorClayProvider.notifier).state = !clay,
            ),
            const NotificationBell(),
            const SizedBox(width: 4),
            // The portal builds its own scaffold rather than using
            // AppShell, so it never inherited the shell's control.
            SignOutAvatar(
              initials: user?.initials ?? 'VN',
              size: 36,
              note:
                  'Unpublished price and stock edits are kept as drafts '
                  'and will still be here when you sign back in.',
            ),
          ],
        ),
      ),
      footer: PrimaryButton(
        label: 'Publish Updates',
        busy: _publishing,
        trailingIcon: Icons.arrow_forward,
        height: clay ? 56 : 52,
        radius: clay ? AppRadii.pill : AppRadii.panel,
        onPressed: _publish,
      ),
      child: catalog.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(myCatalogProvider),
        ),
        data: (data) => ListView(
          padding: const EdgeInsets.only(bottom: 12),
          children: [
            InfoBanner(
              clay: clay,
              message:
                  'Your catalog is live — buyers see prices and stock in real '
                  'time.',
              tone: PillTone.info,
              icon: Icons.check,
            ),
            const SizedBox(height: 12),

            _surface(
              clay: clay,
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
              child: Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 12, bottom: 8),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            'Price list & inventory',
                            style: AppText.listTitle(),
                          ),
                        ),
                        GestureDetector(
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => const AddItemScreen(),
                            ),
                          ),
                          child: Row(
                            children: [
                              const Icon(
                                Icons.add,
                                size: 13,
                                color: AppColors.turquoise,
                              ),
                              const SizedBox(width: 5),
                              Text(
                                'Add Item',
                                style: AppText.caption(
                                  AppColors.turquoise,
                                ).copyWith(fontWeight: FontWeight.w600),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  for (var i = 0; i < data.items.length; i++)
                    _ItemRow(
                      item: data.items[i],
                      clay: clay,
                      isLast: i == data.items.length - 1,
                      price: _pendingPrice[data.items[i].id],
                      stock: _pendingStock[data.items[i].id],
                      onPrice: (v) =>
                          setState(() => _pendingPrice[data.items[i].id] = v),
                      onStock: (v) =>
                          setState(() => _pendingStock[data.items[i].id] = v),
                      onDelete: () => _confirmDelete(data.items[i]),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),

            // The design's "Last published … · N unsaved changes".
            _surface(
              clay: clay,
              radius: AppRadii.panel,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
              child: Row(
                children: [
                  const Icon(Icons.schedule, size: 14, color: AppColors.subtle),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      dirty > 0
                          ? '${data.draft.statusLine.split('·').first.trim()}'
                                ' · $dirty unsaved change'
                                '${dirty == 1 ? '' : 's'}'
                          : data.draft.statusLine,
                      style: AppText.caption(),
                    ),
                  ),
                ],
              ),
            ),

            if (data.draft.itemsMissingTerms > 0) ...[
              const SizedBox(height: 12),
              InfoBanner(
                clay: clay,
                title: 'Missing delivery or warranty',
                message:
                    '${data.draft.itemsMissingTerms} item(s) have no delivery '
                    'time or warranty. Buyers still see them, but the agent '
                    'scores them with reduced data confidence.',
                tone: PillTone.warning,
                icon: Icons.help_outline,
              ),
            ],

            const SizedBox(height: 12),
            // Three ways a catalog row can arrive -- typed above, uploaded, or
            // pulled from a store. All three land in the same table through
            // the same adapter interface.
            _surface(
              clay: clay,
              radius: AppRadii.panel,
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
              child: Column(
                children: [
                  const _QuoteRequestsLink(),
                  const HairLine(),
                  _PortalLink(
                    icon: Icons.upload_file_outlined,
                    title: 'Import a price list',
                    subtitle:
                        'CSV or Excel, with a preview before anything '
                        'is written',
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => const ImportScreen()),
                    ),
                  ),
                  const HairLine(),
                  _PortalLink(
                    icon: Icons.cloud_sync_outlined,
                    title: 'Catalog sources',
                    subtitle: _connectionSubtitle(ref),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => const ConnectionsScreen(),
                      ),
                    ),
                  ),
                  const HairLine(),
                  _PortalLink(
                    icon: Icons.receipt_long_outlined,
                    title: 'Incoming purchase orders',
                    subtitle: 'Orders the agent raised against your catalog',
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => const VendorOrdersScreen(),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmDelete(CatalogItem item) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.white,
        title: Text('Remove ${item.title}?', style: AppText.sectionTitle()),
        content: Text(
          'Buyers stop seeing it immediately. Quotes and purchase orders '
          'already raised against it keep their own price snapshot, so nothing '
          'on record changes.',
          style: AppText.body(),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text('Keep', style: AppText.captionStrong(AppColors.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(
              'Remove',
              style: AppText.captionStrong(AppColors.dangerFg),
            ),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    try {
      await ref.read(apiClientProvider).deleteCatalogItem(item.id);
      _pendingPrice.remove(item.id);
      _pendingStock.remove(item.id);
      ref.invalidate(myCatalogProvider);
      if (!mounted) return;
      showToast(context, '${item.title} removed');
    } on ApiException catch (e) {
      if (!mounted) return;
      showToast(context, e.message, danger: true);
    }
  }

  /// Reads the connection list if it happens to be loaded. The portal must
  /// not wait on it -- this is a subtitle, not the reason the page exists.
  String _connectionSubtitle(WidgetRef ref) {
    final connections = ref.watch(connectionsProvider);
    return connections.maybeWhen(
      data: (items) => items.isEmpty
          ? 'Connect Shopify, WooCommerce or a REST endpoint'
          : '${items.length} connected · '
                '${items.where((c) => c.isConnected).length} syncing',
      orElse: () => 'Connect Shopify, WooCommerce or a REST endpoint',
    );
  }

  Widget _surface({
    required bool clay,
    required Widget child,
    EdgeInsetsGeometry? padding,
    double? radius,
  }) => clay
      ? ClayCard(
          padding: padding ?? const EdgeInsets.all(14),
          radius: radius ?? AppRadii.clayCard,
          child: child,
        )
      : GlassCard(
          padding: padding ?? const EdgeInsets.all(14),
          radius: radius ?? AppRadii.card,
          child: child,
        );
}

/// Quote requests, with a count of the ones still waiting on an answer.
///
/// Its own widget rather than a plain _PortalLink so the badge can watch the
/// count without rebuilding the entire portal each time it changes.
class _QuoteRequestsLink extends ConsumerWidget {
  const _QuoteRequestsLink();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final open = ref.watch(openQuoteCountProvider).maybeWhen(
          data: (n) => n,
          orElse: () => 0,
        );
    return _PortalLink(
      icon: Icons.request_quote_outlined,
      title: 'Quote requests',
      subtitle: open == 0
          ? 'Buyers looking for something nobody has listed'
          : '$open waiting on your reply',
      badge: open == 0 ? null : '$open',
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const QuoteRequestsScreen()),
      ),
    );
  }
}

/// A tappable row in the portal's action list.
class _PortalLink extends StatelessWidget {
  const _PortalLink({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.badge,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  /// A count worth interrupting for, e.g. unanswered quote requests.
  final String? badge;

  @override
  Widget build(BuildContext context) => GestureDetector(
    onTap: () {
      HapticFeedback.selectionClick();
      onTap();
    },
    behavior: HitTestBehavior.opaque,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 13),
      child: Row(
        children: [
          Icon(icon, size: 18, color: AppColors.turquoise),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: AppText.listTitle()),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: AppText.meta(),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          if (badge != null) ...[
            StatusPill(
              label: badge!,
              tone: PillTone.danger,
              showDot: false,
              dense: true,
            ),
            const SizedBox(width: 6),
          ],
          const Icon(Icons.chevron_right, color: AppColors.subtle),
        ],
      ),
    ),
  );
}

/// One editable catalog row: title, a price field and a -/+ stock stepper.
///
/// Long-press removes the listing. It is deliberately not a visible button:
/// the design's row is a price and stock editor, and a delete control one tap
/// from the stock stepper is the wrong thing to make easy.
class _ItemRow extends StatelessWidget {
  const _ItemRow({
    required this.item,
    required this.clay,
    required this.isLast,
    required this.onPrice,
    required this.onStock,
    required this.onDelete,
    this.price,
    this.stock,
  });

  final CatalogItem item;
  final bool clay;
  final bool isLast;
  final double? price;
  final int? stock;
  final ValueChanged<double> onPrice;
  final ValueChanged<int> onStock;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final currentStock = stock ?? item.stock;
    final currentPrice = price ?? item.price;

    return GestureDetector(
      onLongPress: () {
        HapticFeedback.mediumImpact();
        onDelete();
      },
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          border: isLast
              ? null
              : const Border(bottom: BorderSide(color: AppColors.dividerAlt)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(item.title, style: AppText.listTitleSm()),
                      if (item.description != null)
                        Text(item.description!, style: AppText.meta()),
                    ],
                  ),
                ),
                const SizedBox(width: 10),

                // -- price field (recessed in clay, outlined in glass) ----
                GestureDetector(
                  onTap: () => _editPrice(context, currentPrice),
                  child: clay
                      ? ClayCard(
                          recessed: true,
                          radius: AppRadii.control,
                          color: AppColors.clayRecess,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 9,
                          ),
                          child: SizedBox(
                            width: 74,
                            child: Text(
                              _fmt(currentPrice),
                              textAlign: TextAlign.right,
                              style: AppText.captionStrong(AppColors.turquoise),
                            ),
                          ),
                        )
                      : Container(
                          width: 96,
                          height: 36,
                          alignment: Alignment.centerRight,
                          padding: const EdgeInsets.symmetric(horizontal: 10),
                          decoration: BoxDecoration(
                            color: AppColors.inputFill,
                            borderRadius: BorderRadius.circular(AppRadii.field),
                            border: Border.all(
                              color: AppColors.glacier,
                              width: 1.5,
                            ),
                          ),
                          child: Text(
                            _fmt(currentPrice),
                            style: AppText.captionStrong(AppColors.turquoise),
                          ),
                        ),
                ),
                const SizedBox(width: 8),

                // -- stock stepper ---------------------------------------
                _Stepper(clay: clay, value: currentStock, onChanged: onStock),
              ],
            ),
            if (item.isLowStock) ...[
              const SizedBox(height: 6),
              const StatusPill(
                label: 'Low stock',
                tone: PillTone.neutral,
                showDot: false,
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _fmt(double v) => formatMoney(v, '').trim();

  Future<void> _editPrice(BuildContext context, double current) async {
    final controller = TextEditingController(text: current.round().toString());
    final result = await showDialog<double>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.panel),
        ),
        title: Text(item.title, style: AppText.sectionTitle()),
        content: TextField(
          controller: controller,
          keyboardType: TextInputType.number,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'Unit price'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text('Cancel', style: AppText.caption()),
          ),
          TextButton(
            onPressed: () =>
                Navigator.of(ctx).pop(double.tryParse(controller.text)),
            child: Text(
              'Save',
              style: AppText.captionStrong(AppColors.turquoise),
            ),
          ),
        ],
      ),
    );
    if (result != null && result >= 0) onPrice(result);
  }
}

class _Stepper extends StatelessWidget {
  const _Stepper({
    required this.clay,
    required this.value,
    required this.onChanged,
  });

  final bool clay;
  final int value;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final content = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        GestureDetector(
          onTap: value > 0 ? () => onChanged(value - 1) : null,
          child: Text('−', style: AppText.listTitle(AppColors.muted)),
        ),
        SizedBox(
          width: 34,
          child: Text(
            '$value',
            textAlign: TextAlign.center,
            style: AppText.captionStrong(),
          ),
        ),
        GestureDetector(
          onTap: () => onChanged(value + 1),
          child: Text('+', style: AppText.listTitle(AppColors.turquoise)),
        ),
      ],
    );

    return clay
        ? ClayCard(
            radius: AppRadii.control,
            shadows: AppShadows.claySmall,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            child: content,
          )
        : Container(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AppRadii.field),
              border: Border.all(color: AppColors.divider),
            ),
            child: content,
          );
  }
}

// ===========================================================================
// Screen 14b -- add item
// ===========================================================================
class AddItemScreen extends ConsumerStatefulWidget {
  const AddItemScreen({super.key});

  @override
  ConsumerState<AddItemScreen> createState() => _AddItemScreenState();
}

class _AddItemScreenState extends ConsumerState<AddItemScreen> {
  final _sku = TextEditingController();
  final _title = TextEditingController();
  final _description = TextEditingController();
  final _price = TextEditingController();
  final _stock = TextEditingController();
  final _delivery = TextEditingController();
  final _warranty = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [
      _sku,
      _title,
      _description,
      _price,
      _stock,
      _delivery,
      _warranty,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      await ref
          .read(apiClientProvider)
          .createCatalogItem(
            sku: _sku.text.trim(),
            title: _title.text.trim(),
            price: double.parse(_price.text),
            stock: int.parse(_stock.text),
            description: _description.text.trim().isEmpty
                ? null
                : _description.text.trim(),
            deliveryDays: int.tryParse(_delivery.text),
            warrantyMonths: int.tryParse(_warranty.text),
          );
      ref.invalidate(myCatalogProvider);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const ItemPublishedScreen(count: 1)),
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context) => AppScaffold(
    header: const AppHeader(
      title: 'Add Item',
      subtitle: 'Delivery and warranty are required',
    ),
    footer: PrimaryButton(label: 'Save item', busy: _busy, onPressed: _save),
    child: Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.only(bottom: 12),
        children: [
          GlassCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _field('SKU', _sku, hint: 'TS-LAT-5550', required: true),
                _field(
                  'Title',
                  _title,
                  hint: 'Dell Latitude 5550 laptop',
                  required: true,
                ),
                _field('Description', _description, hint: 'i7 · 16GB · 512GB'),
              ],
            ),
          ),
          const SizedBox(height: 12),
          GlassCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: _field(
                        'Unit price',
                        _price,
                        hint: '174000',
                        number: true,
                        required: true,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: _field(
                        'Stock',
                        _stock,
                        hint: '240',
                        number: true,
                        required: true,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),

          // The brief EXTENDS the design's form with these two fields.
          GlassCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Commercial terms', style: AppText.sectionTitle()),
                const SizedBox(height: 4),
                Text(
                  'Leave blank to inherit your profile defaults. Items '
                  'with neither are scored at reduced data confidence.',
                  style: AppText.meta(),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: _field(
                        'Delivery (days)',
                        _delivery,
                        hint: '7',
                        number: true,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: _field(
                        'Warranty (months)',
                        _warranty,
                        hint: '24',
                        number: true,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );

  Widget _field(
    String label,
    TextEditingController controller, {
    String? hint,
    bool number = false,
    bool required = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: AppText.captionStrong(AppColors.muted)),
        const SizedBox(height: 6),
        TextFormField(
          controller: controller,
          keyboardType: number ? TextInputType.number : TextInputType.text,
          decoration: InputDecoration(hintText: hint),
          validator: required
              ? (v) => (v == null || v.trim().isEmpty)
                    ? '$label is required'
                    : null
              : null,
        ),
      ],
    ),
  );
}

// ===========================================================================
// Screen 14c -- item published
// ===========================================================================
class ItemPublishedScreen extends StatelessWidget {
  const ItemPublishedScreen({super.key, required this.count});

  final int count;

  @override
  Widget build(BuildContext context) => AppScaffold(
    header: const AppHeader(title: 'Published'),
    footer: PrimaryButton(
      label: 'Back to portal',
      onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst),
    ),
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 78,
            height: 78,
            decoration: const BoxDecoration(
              color: AppColors.successBg,
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.cloud_done_outlined,
              size: 38,
              color: AppColors.successFg,
            ),
          ),
          const SizedBox(height: 20),
          Text('Catalog published', style: AppText.pageTitle()),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 34),
            child: Text(
              count == 0
                  ? 'Everything was already up to date.'
                  : '$count item${count == 1 ? '' : 's'} published. Buyers '
                        'and the agent can see the new pricing immediately.',
              textAlign: TextAlign.center,
              style: AppText.caption(),
            ),
          ),
        ],
      ),
    ),
  );
}

// ===========================================================================
// Vendor purchase orders + delivery status (generated -- not in the design)
// ===========================================================================
class VendorOrdersScreen extends ConsumerWidget {
  const VendorOrdersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final orders = ref.watch(myPurchaseOrdersProvider);

    return AppScaffold(
      header: const AppHeader(
        title: 'Purchase Orders',
        subtitle: 'Orders addressed to you',
      ),
      child: orders.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(message: '$e'),
        data: (page) {
          if (page.items.isEmpty) {
            return const EmptyState(
              title: 'No orders yet',
              message:
                  'Purchase orders raised against your catalog appear '
                  'here.',
              icon: Icons.receipt_long_outlined,
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.only(bottom: 24),
            itemCount: page.items.length,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (_, i) => _OrderCard(order: page.items[i]),
          );
        },
      ),
    );
  }
}

class _OrderCard extends ConsumerWidget {
  const _OrderCard({required this.order});

  final PurchaseOrder order;

  Future<void> _update(
    BuildContext context,
    WidgetRef ref,
    PODeliveryStatus status,
  ) async {
    try {
      await ref
          .read(apiClientProvider)
          .updateDeliveryStatus(
            order.id,
            status: status,
            quantityDelivered: status == PODeliveryStatus.delivered
                ? order.totalUnits
                : null,
          );
      ref.invalidate(myPurchaseOrdersProvider);
      if (context.mounted) {
        showToast(context, 'Marked ${status.label.toLowerCase()}');
      }
    } on ApiException catch (e) {
      if (context.mounted) showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) => ClayCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(order.poNumber, style: AppText.sectionTitle()),
            ),
            StatusPill(
              label: order.deliveryStatus.label,
              tone: switch (order.deliveryStatus) {
                PODeliveryStatus.delivered => PillTone.success,
                PODeliveryStatus.cancelled => PillTone.danger,
                PODeliveryStatus.inTransit => PillTone.info,
                _ => PillTone.neutral,
              },
            ),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          '${formatMoney(order.totalAmount, order.currency)} · '
          '${order.totalUnits} units',
          style: AppText.caption(),
        ),
        if (order.expectedDeliveryDate != null)
          Text(
            'Expected ${order.expectedDeliveryDate!.day}/'
            '${order.expectedDeliveryDate!.month}/'
            '${order.expectedDeliveryDate!.year}',
            style: AppText.meta(),
          ),

        // What was actually ordered. A supplier cannot fulfil a total; they
        // fulfil lines. This card previously showed neither the items nor the
        // terms, which made it impossible to act on without leaving the app.
        if (order.lineItems.isNotEmpty) ...[
          const SizedBox(height: 12),
          const HairLine(),
          for (final li in order.lineItems)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(li.description, style: AppText.listTitleSm()),
                        const SizedBox(height: 2),
                        Text(
                          [
                            if (li.sku != null && li.sku!.isNotEmpty) li.sku!,
                            '${li.quantity} × '
                                '${formatMoney(li.unitPrice, order.currency)}',
                          ].join(' · '),
                          style: AppText.meta(),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    formatMoney(li.lineTotal, order.currency),
                    style: AppText.captionStrong(AppColors.ink),
                  ),
                ],
              ),
            ),
        ],

        if (order.deliveryDays != null || order.warrantyMonths != null) ...[
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              if (order.deliveryDays != null)
                EntityChip(label: '${order.deliveryDays} day delivery'),
              if (order.warrantyMonths != null)
                EntityChip(label: formatWarranty(order.warrantyMonths)),
            ],
          ),
        ],

        const SizedBox(height: 12),
        PdfButton(pdfUrl: order.pdfUrl, label: 'View the order (PDF)'),

        const SizedBox(height: 12),
        Text(
          'Updating this feeds your reliability score.',
          style: AppText.meta(),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            // Driven by the server, not a fixed list. An order that is
            // already delivered offers nothing, and an order cannot go
            // backwards -- the chips say so instead of failing on tap.
            for (final s in order.nextStates)
              FilterChipButton(
                label: s.label,
                selected: false,
                onTap: () => _update(context, ref, s),
              ),
            if (order.nextStates.isEmpty)
              Text(
                order.deliveryStatus == PODeliveryStatus.delivered
                    ? 'Delivered — nothing further to do.'
                    : 'This order is closed.',
                style: AppText.meta(),
              ),
          ],
        ),
      ],
    ),
  );
}
