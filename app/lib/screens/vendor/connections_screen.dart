/// Catalog API connections for the vendor portal.
///
/// A vendor points us at their Shopify / WooCommerce / REST store once, and
/// Sync Now pulls their listings into the catalog the agent reads.
///
/// The sync is DELIBERATELY SIMULATED. Every part of this flow is real -- the
/// connection row, the credential handling, the adapter, the upsert-by-SKU,
/// the counts you see afterwards -- except the outbound HTTP call, which
/// returns a seeded fixture instead. That is stated on screen rather than
/// implied, because a demo that looks like it called Shopify and did not is
/// worse than one that says so.
///
/// It also protects the rule the whole system rests on: the agent reads
/// catalog rows out of our database and never makes an outbound call for
/// supplier data. Sync is a vendor-side action on the vendor's own schedule.
/// Nothing on the execution path can reach it.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/import_models.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../state/cached.dart';

class ConnectionsScreen extends ConsumerWidget {
  const ConnectionsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final connections = ref.watch(connectionsProvider);

    return AppScaffold(
      header: const AppHeader(
        title: 'Catalog sources',
        subtitle: 'Sync pricing from your store',
      ),
      footer: PrimaryButton(
        label: 'Connect a source',
        icon: Icons.add_link,
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const ConnectSourceScreen()),
        ),
      ),
      child: connections.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(connectionsProvider),
        ),
        data: (items) => RefreshIndicator(
          color: AppColors.turquoise,
          onRefresh: () async => ref.refresh(connectionsProvider.future),
          child: ListView(
            padding: const EdgeInsets.only(bottom: 20),
            children: [
              const _SimulationNotice(),
              const SizedBox(height: 12),
              if (items.isEmpty)
                const EmptyState(
                  icon: Icons.cloud_off_outlined,
                  title: 'No sources connected',
                  message: 'Connect a store to keep your catalog in step with '
                      'it, or import a spreadsheet instead.',
                )
              else
                for (final connection in items)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _ConnectionCard(connection: connection),
                  ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SimulationNotice extends StatelessWidget {
  const _SimulationNotice();

  @override
  Widget build(BuildContext context) => const InfoBanner(
        title: 'Sync returns seeded data',
        message: 'The connection, credentials and catalog write are real. The '
            'provider call is not — no request leaves this server. The agent '
            'never syncs; it reads only what is already in the catalog.',
        tone: PillTone.info,
        icon: Icons.science_outlined,
      );
}

class _ConnectionCard extends ConsumerStatefulWidget {
  const _ConnectionCard({required this.connection});

  final CatalogConnection connection;

  @override
  ConsumerState<_ConnectionCard> createState() => _ConnectionCardState();
}

class _ConnectionCardState extends ConsumerState<_ConnectionCard> {
  bool _syncing = false;

  Future<void> _sync() async {
    setState(() => _syncing = true);
    try {
      final result =
          await ref.read(apiClientProvider).syncConnection(widget.connection.id);
      ref.invalidate(connectionsProvider);
      ref.invalidate(myCatalogProvider);
      if (!mounted) return;
      setState(() => _syncing = false);
      showToast(
        context,
        '${result.itemsCreated} added · ${result.itemsUpdated} updated'
        '${result.itemsSkipped > 0 ? ' · ${result.itemsSkipped} skipped' : ''}',
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _syncing = false);
      showToast(context, e.message, danger: true);
    }
  }

  Future<void> _disconnect() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.white,
        title: Text(
          'Disconnect ${widget.connection.label}?',
          style: AppText.sectionTitle(),
        ),
        content: Text(
          'Items already synced stay in your catalog. Only the connection is '
          'removed, and its stored credentials with it.',
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
              'Disconnect',
              style: AppText.captionStrong(AppColors.dangerFg),
            ),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    try {
      await ref.read(apiClientProvider).deleteConnection(widget.connection.id);
      ref.invalidate(connectionsProvider);
      if (!mounted) return;
      showToast(context, '${widget.connection.label} disconnected');
    } on ApiException catch (e) {
      if (!mounted) return;
      showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final connection = widget.connection;
    final provider = CatalogProviderOption.fromWire(connection.provider);

    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  gradient: AppGradients.avatar,
                  borderRadius: BorderRadius.circular(AppRadii.chip),
                ),
                child: const Icon(
                  Icons.storefront_outlined,
                  size: 17,
                  color: AppColors.white,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      connection.label,
                      style: AppText.listTitle(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(provider.label, style: AppText.meta()),
                  ],
                ),
              ),
              StatusPill(
                label: connection.isConnected ? 'Connected' : 'Idle',
                tone: connection.hasError
                    ? PillTone.danger
                    : connection.isConnected
                        ? PillTone.success
                        : PillTone.neutral,
              ),
            ],
          ),
          if (connection.storeUrl != null) ...[
            const SizedBox(height: 10),
            _Detail(icon: Icons.link, text: connection.storeUrl!),
          ],
          const SizedBox(height: 6),
          _Detail(
            icon: Icons.sync_outlined,
            text: connection.lastSyncItemCount != null
                ? '${connection.statusLine} · '
                    '${connection.lastSyncItemCount} items'
                : connection.statusLine,
          ),
          const SizedBox(height: 6),
          _Detail(
            icon: connection.credentialsSet
                ? Icons.lock_outline
                : Icons.lock_open_outlined,
            text: connection.credentialsSet
                ? 'Credentials stored — never shown again'
                : 'No credentials stored',
          ),
          if (connection.lastError != null &&
              connection.lastError!.isNotEmpty) ...[
            const SizedBox(height: 10),
            MutedSurface(
              child: Text(
                connection.lastError!,
                style: AppText.meta(AppColors.dangerFg),
              ),
            ),
          ],
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: SecondaryButton(
                  label: _syncing ? 'Syncing…' : 'Sync Now',
                  icon: Icons.sync,
                  onPressed: _syncing ? null : _sync,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: DangerButton(
                  label: 'Disconnect',
                  onPressed: _disconnect,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// One icon-and-text line of connection detail.
class _Detail extends StatelessWidget {
  const _Detail({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 13, color: AppColors.subtle),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              text,
              style: AppText.meta(),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      );
}

// ===========================================================================
// Connect form
// ===========================================================================
class ConnectSourceScreen extends ConsumerStatefulWidget {
  const ConnectSourceScreen({super.key});

  @override
  ConsumerState<ConnectSourceScreen> createState() =>
      _ConnectSourceScreenState();
}

class _ConnectSourceScreenState extends ConsumerState<ConnectSourceScreen> {
  final _formKey = GlobalKey<FormState>();
  final _label = TextEditingController();
  final _storeUrl = TextEditingController();
  final _apiKey = TextEditingController();
  final _apiSecret = TextEditingController();

  CatalogProviderOption _provider = CatalogProviderOption.shopify;
  bool _autoSync = false;
  bool _busy = false;
  bool _revealSecret = false;

  @override
  void dispose() {
    for (final c in [_label, _storeUrl, _apiKey, _apiSecret]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _connect() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      final connection = await ref.read(apiClientProvider).createConnection(
            provider: _provider.wire,
            label: _label.text.trim(),
            storeUrl: _storeUrl.text.trim(),
            apiKey: _apiKey.text.trim(),
            apiSecret: _apiSecret.text.trim(),
            autoSync: _autoSync,
          );
      ref.invalidate(connectionsProvider);
      if (!mounted) return;
      Navigator.of(context).pop();
      showToast(context, '${connection.label} connected');
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      showToast(context, e.message, danger: true);
    }
  }

  @override
  Widget build(BuildContext context) => AppScaffold(
        header: const AppHeader(
          title: 'Connect a source',
          subtitle: 'Credentials are stored write-only',
        ),
        footer: PrimaryButton(
          label: 'Connect',
          busy: _busy,
          onPressed: _connect,
        ),
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.only(bottom: 12),
            children: [
              GlassCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Provider', style: AppText.captionStrong(AppColors.muted)),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final option in CatalogProviderOption.values)
                          FilterChipButton(
                            label: option.label,
                            selected: _provider == option,
                            onTap: () => setState(() => _provider = option),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              GlassCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _field(
                      'Name',
                      _label,
                      hint: 'My ${_provider.label} store',
                      isRequired: true,
                    ),
                    _field(
                      'Store URL',
                      _storeUrl,
                      hint: _provider.urlHint,
                    ),
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
                        const Icon(
                          Icons.lock_outline,
                          size: 15,
                          color: AppColors.muted,
                        ),
                        const SizedBox(width: 6),
                        Text('Credentials', style: AppText.sectionTitle()),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Sent once and never returned by the API. You will only '
                      'ever see whether they are set.',
                      style: AppText.explain(),
                    ),
                    const SizedBox(height: 12),
                    _field('API key', _apiKey, hint: 'ck_…', obscure: true),
                    _field(
                      'API secret',
                      _apiSecret,
                      hint: 'cs_…',
                      obscure: !_revealSecret,
                      trailing: IconButton(
                        icon: Icon(
                          _revealSecret
                              ? Icons.visibility_off_outlined
                              : Icons.visibility_outlined,
                          size: 18,
                          color: AppColors.muted,
                        ),
                        onPressed: () =>
                            setState(() => _revealSecret = !_revealSecret),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              GlassCard(
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Sync automatically',
                            style: AppText.captionStrong(AppColors.ink),
                          ),
                          const SizedBox(height: 3),
                          Text(
                            'Re-pull the catalog on a schedule instead of '
                            'pressing Sync Now.',
                            style: AppText.meta(),
                          ),
                        ],
                      ),
                    ),
                    Switch(
                      value: _autoSync,
                      activeThumbColor: AppColors.turquoise,
                      onChanged: (v) => setState(() => _autoSync = v),
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
    bool isRequired = false,
    bool obscure = false,
    Widget? trailing,
  }) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: AppText.captionStrong(AppColors.muted)),
            const SizedBox(height: 6),
            TextFormField(
              controller: controller,
              obscureText: obscure,
              autocorrect: false,
              enableSuggestions: false,
              decoration: InputDecoration(
                hintText: hint,
                suffixIcon: trailing,
              ),
              validator: isRequired
                  ? (v) => (v == null || v.trim().isEmpty)
                      ? '$label is required'
                      : null
                  : null,
            ),
          ],
        ),
      );
}
