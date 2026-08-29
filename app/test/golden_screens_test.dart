/// Renders real screens against the captured API fixtures.
///
///   flutter test --update-goldens test/golden_screens_test.dart
///
/// This is the design-review artefact: the screens are driven by the SAME
/// JSON the live backend returned, so what appears here is what a user sees.
library;

import 'dart:convert';
import 'dart:io';

import 'package:agentflow/api/models.dart';
import 'package:agentflow/theme/app_theme.dart';
import 'package:agentflow/theme/surfaces.dart';
import 'package:agentflow/theme/tokens.dart';
import 'package:agentflow/widgets/common.dart';
import 'package:agentflow/widgets/shell.dart';
import 'package:agentflow/widgets/workflow_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/test_fonts.dart';

Map<String, dynamic> _json(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync())
        as Map<String, dynamic>;

List<Quote> _quotes(String file) =>
    ((_json(file)['quotes'] as List))
        .map((e) => Quote.fromJson(e as Map<String, dynamic>))
        .toList();

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  double height = 900,
}) async {
  tester.view.physicalSize = Size(402 * 2, height * 2);
  tester.view.devicePixelRatio = 2.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      home: child,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(loadAppFonts);

  testWidgets('5a supplier comparison', (tester) async {
    final quotes = _quotes('comparison_single.json');
    await _pump(
      tester,
      AppScaffold(
        header: const AppHeader(
          title: 'Supplier Comparison',
          subtitle: 'Step 4 · Score & rank suppliers',
        ),
        child: ListView(
          children: [
            for (final q in quotes) ...[
              VendorQuoteCard(quote: q),
              const SizedBox(height: 10),
            ],
            GlassCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text('Scoring', style: AppText.sectionTitle()),
                      ),
                      Text(
                        'Price 50% · Delivery 30% · Warranty 20%',
                        style: AppText.meta(),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  for (final q in quotes)
                    ScoreBreakdownBar(
                      label: q.vendorName.split(' ').first,
                      components: q.components,
                      total: q.scoreTotal,
                      dimmed: q.status.isExcluded,
                      excludedLabel: q.status.isExcluded ? '—' : null,
                    ),
                  const ScoreLegend(),
                ],
              ),
            ),
            const SizedBox(height: 12),
            const InfoBanner(
              title: 'Selected TechSupplies Ltd',
              message:
                  'Lowest qualifying total PKR 8,700,000, 7-day delivery, '
                  '2-year warranty.',
              icon: Icons.check_circle_outline,
            ),
          ],
        ),
      ),
      height: 1000,
    );
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/screen_5a_comparison.png'),
    );
  });

  testWidgets('11a multi-item comparison', (tester) async {
    final quotes = _quotes('comparison_multi.json');
    await _pump(
      tester,
      AppScaffold(
        header: const AppHeader(
          title: 'Supplier Comparison',
          subtitle: 'Mixed order · 3 line items · budget PKR 12M',
        ),
        child: ListView(
          children: [
            const Wrap(
              spacing: 8,
              children: [
                EntityChip(label: 'Laptops × 50'),
                EntityChip(label: 'CPU kits × 20'),
                EntityChip(label: 'Docking kits × 60'),
              ],
            ),
            const SizedBox(height: 12),
            for (final q in quotes) ...[
              VendorQuoteCard(quote: q, showLines: true),
              const SizedBox(height: 10),
            ],
            const InfoBanner(
              title: 'Selected TechSupplies Ltd',
              message:
                  'Only in-budget supplier covering all 3 line items in one '
                  'PO. Total PKR 11,310,000 (94% of budget). Splitting would '
                  'add a second purchase order and longer lead time.',
              icon: Icons.check_circle_outline,
            ),
          ],
        ),
      ),
      height: 1180,
    );
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/screen_11a_multi.png'),
    );
  });

  testWidgets('6a validation passed', (tester) async {
    final report = ValidationReport.fromJson(_json('validation.json'));
    await _pump(
      tester,
      AppScaffold(
        header: AppHeader(
          title: 'Validation Results',
          subtitle: 'Step 7 · ${report.summaryLabel}',
          trailing: const StatusPill(label: 'Passed', tone: PillTone.success),
        ),
        child: ListView(
          children: [
            GlassCard(
              child: Row(
                children: [
                  Container(
                    width: 46,
                    height: 46,
                    decoration: const BoxDecoration(
                      color: AppColors.successBg,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.verified,
                      color: AppColors.successFg,
                      size: 22,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          report.summaryLabel,
                          style: AppText.sectionTitle(),
                        ),
                        Text(
                          'The purchase order is consistent with the quote it '
                          'was priced from.',
                          style: AppText.caption(),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            for (final c in report.checks) ValidationCheckRow(check: c),
          ],
        ),
      ),
      height: 1000,
    );
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/screen_6a_validation.png'),
    );
  });

  testWidgets('4a live execution stepper', (tester) async {
    final wf = WorkflowDetail.fromJson(_json('workflow_detail.json'));
    await _pump(
      tester,
      AppScaffold(
        header: AppHeader(
          title: wf.title,
          subtitle: 'Finished in 73.3s',
          trailing: StatusPill.forWorkflow(wf.status),
        ),
        child: ListView(
          children: [
            GlassCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text('Execution', style: AppText.sectionTitle()),
                      ),
                      Text(
                        '${wf.progressPercent}%',
                        style: AppText.captionStrong(AppColors.turquoise),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(AppRadii.pill),
                    child: LinearProgressIndicator(
                      value: wf.progressPercent / 100,
                      minHeight: 6,
                      backgroundColor: AppColors.divider,
                      valueColor:
                          const AlwaysStoppedAnimation(AppColors.turquoise),
                    ),
                  ),
                  const SizedBox(height: 14),
                  for (var i = 0; i < wf.steps.length; i++)
                    StepRow(
                      step: wf.steps[i],
                      isLast: i == wf.steps.length - 1,
                      expanded: wf.steps[i].name == 'fetch_quotes',
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
      height: 900,
    );
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/screen_4a_execution.png'),
    );
  });

  testWidgets('14d vendor portal in clay', (tester) async {
    final data = _json('catalog_me.json');
    final items = (data['items'] as List)
        .map((e) => CatalogItem.fromJson(e as Map<String, dynamic>))
        .toList();
    final draft = CatalogDraftState.fromJson(
      data['draft_state'] as Map<String, dynamic>,
    );

    await _pump(
      tester,
      AppScaffold(
        vendor: true,
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
                      'TechSupplies Ltd · signed in as vendor',
                      style: AppText.caption(),
                    ),
                  ],
                ),
              ),
              const AvatarCircle(initials: 'TS', size: 36),
            ],
          ),
        ),
        footer: const PrimaryButton(
          label: 'Publish Updates',
          height: 56,
          radius: AppRadii.pill,
          trailingIcon: Icons.arrow_forward,
        ),
        child: ListView(
          children: [
            const InfoBanner(
              clay: true,
              message:
                  'Your catalog is live — buyers see prices and stock in real '
                  'time.',
              tone: PillTone.info,
              icon: Icons.check,
            ),
            const SizedBox(height: 12),
            ClayCard(
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
                        Text(
                          '+ Add Item',
                          style: AppText.caption(AppColors.turquoise)
                              .copyWith(fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
                  ),
                  for (final item in items.take(4))
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(item.title, style: AppText.listTitleSm()),
                                if (item.description != null)
                                  Text(
                                    item.description!,
                                    style: AppText.meta(),
                                  ),
                              ],
                            ),
                          ),
                          ClayCard(
                            recessed: true,
                            radius: AppRadii.control,
                            color: AppColors.clayRecess,
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 9,
                            ),
                            child: SizedBox(
                              width: 66,
                              child: Text(
                                formatMoney(item.price, '').trim(),
                                textAlign: TextAlign.right,
                                style: AppText.captionStrong(
                                  AppColors.turquoise,
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          ClayCard(
                            radius: AppRadii.control,
                            shadows: AppShadows.claySmall,
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 6,
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  '−',
                                  style: AppText.listTitle(AppColors.muted),
                                ),
                                SizedBox(
                                  width: 32,
                                  child: Text(
                                    '${item.stock}',
                                    textAlign: TextAlign.center,
                                    style: AppText.captionStrong(),
                                  ),
                                ),
                                Text(
                                  '+',
                                  style:
                                      AppText.listTitle(AppColors.turquoise),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            ClayCard(
              radius: AppRadii.panel,
              padding: const EdgeInsets.symmetric(
                horizontal: 16,
                vertical: 11,
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.schedule,
                    size: 14,
                    color: AppColors.subtle,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(draft.statusLine, style: AppText.caption()),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      height: 860,
    );
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/screen_14d_vendor_clay.png'),
    );
  });
}
