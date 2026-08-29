/// Screen 18a detail — one vendor, everything on record.
///
/// The management list shows enough to decide verify/suspend at a glance. This
/// is the view for when that is not enough: the reliability history the
/// scorer actually reads, the open flags behind it, and what the vendor lists.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/models.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../widgets/workflow_widgets.dart';
import '../../state/cached.dart';

class VendorDetailScreen extends ConsumerWidget {
  const VendorDetailScreen({super.key, required this.vendorId});

  final String vendorId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final vendor = ref.watch(vendorDetailProvider(vendorId));

    return AppScaffold(
      header: const AppHeader(title: 'Vendor', subtitle: 'Full record'),
      child: vendor.cachedWhen(
        loading: () => const LoadingState(),
        error: (e, _) => ErrorState(
          message: '$e',
          onRetry: () => ref.invalidate(vendorDetailProvider(vendorId)),
        ),
        data: (v) => ListView(
          padding: const EdgeInsets.only(bottom: 20),
          children: [
            GlassCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(v.name, style: AppText.pageTitle()),
                      ),
                      StatusPill.forVendor(v.status),
                    ],
                  ),
                  if (v.category != null) ...[
                    const SizedBox(height: 6),
                    Text(v.category!, style: AppText.caption()),
                  ],
                  const SizedBox(height: 12),
                  MetaRow(label: 'Contact', value: v.email ?? '—'),
                  if (v.phone != null) ...[
                    const SizedBox(height: 6),
                    MetaRow(label: 'Phone', value: v.phone!),
                  ],
                  const SizedBox(height: 6),
                  MetaRow(
                    label: 'Default delivery',
                    value: v.defaultDeliveryDays != null
                        ? '${v.defaultDeliveryDays} days'
                        : 'Not set',
                  ),
                  const SizedBox(height: 6),
                  MetaRow(
                    label: 'Default warranty',
                    value: formatWarranty(v.defaultWarrantyMonths),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            const SectionHeader(title: 'Reliability'),
            const SizedBox(height: 8),
            _ReliabilityCard(vendor: v),
            if (v.flags.isNotEmpty) ...[
              const SizedBox(height: 16),
              SectionHeader(title: 'Open flags (${v.flags.length})'),
              const SizedBox(height: 8),
              for (final flag in v.flags)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: InfoBanner(
                    title: flag.reason,
                    message: flag.detail,
                    tone: PillTone.danger,
                    icon: Icons.flag_outlined,
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ReliabilityCard extends StatelessWidget {
  const _ReliabilityCard({required this.vendor});

  final Vendor vendor;

  @override
  Widget build(BuildContext context) {
    final reliability = vendor.reliability;

    if (!reliability.hasHistory) {
      return GlassCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('No delivery history', style: AppText.sectionTitle()),
            const SizedBox(height: 6),
            Text(
              'The scorer leaves reliability out for this vendor rather than '
              'scoring it zero. A new supplier is not penalised for being new.',
              style: AppText.explain(),
            ),
          ],
        ),
      );
    }

    final rate = reliability.onTimeRate ?? 0;
    return Row(
      children: [
        Expanded(
          child: StatCard(
            value: '${(rate * 100).round()}%',
            label: 'On-time rate',
            tone: rate >= 0.9
                ? 'positive'
                : rate >= 0.75
                    ? 'warning'
                    : 'danger',
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: StatCard(
            value: '${reliability.ordersFulfilled}',
            label: 'Orders fulfilled',
          ),
        ),
      ],
    );
  }
}
