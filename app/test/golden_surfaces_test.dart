/// Renders the surface recipes to a PNG so the treatments can be inspected
/// by eye, not just asserted numerically.
///
///   flutter test --update-goldens test/golden_surfaces_test.dart
///
/// The output lands in test/goldens/. Fonts are the test-harness fallback
/// (Ahem-like metrics are disabled here), so judge the SURFACES -- blur,
/// extrusion, shadow, border -- rather than the letterforms.
library;

import 'package:agentflow/theme/app_theme.dart';
import 'package:agentflow/theme/surfaces.dart';
import 'package:agentflow/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/test_fonts.dart';

void main() {
  setUpAll(loadAppFonts);

  testWidgets('surface treatments', (tester) async {
    // The design is authored at the iPhone content width of 402pt.
    tester.view.physicalSize = const Size(402 * 2, 900 * 2);
    tester.view.devicePixelRatio = 2.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        home: Scaffold(
          body: PageBackground(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 44, 20, 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // -- opaque hero gradient (screen 1a) -------------------
                  Container(
                    padding: const EdgeInsets.all(18),
                    decoration: BoxDecoration(
                      gradient: AppGradients.hero,
                      borderRadius: BorderRadius.circular(AppRadii.card),
                      boxShadow: AppShadows.hero,
                    ),
                    child: const Text(
                      'Good morning —\n2 items need your attention',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                        height: 1.25,
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),

                  // -- three glass stat tiles (screen 1a) -----------------
                  Row(
                    children: [
                      _stat('4', 'Active workflows', AppColors.turquoise),
                      const SizedBox(width: 10),
                      _stat('2', 'Pending approvals', AppColors.warningFg),
                      const SizedBox(width: 10),
                      _stat('12', 'Completed', AppColors.successFg),
                    ],
                  ),
                  const SizedBox(height: 12),

                  // -- winner card (screen 5a) ---------------------------
                  OutlinedSurface(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Expanded(
                              child: Text(
                                'TechSupplies Ltd',
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 9,
                                vertical: 3,
                              ),
                              decoration: BoxDecoration(
                                color: AppColors.successSolid,
                                borderRadius:
                                    BorderRadius.circular(AppRadii.pill),
                              ),
                              child: const Text(
                                'Best Option',
                                style: TextStyle(
                                  color: Colors.white,
                                  fontSize: 10.5,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        const Text(
                          'PKR 8,700,000  ·  7 days  ·  2 years',
                          style: TextStyle(
                            fontSize: 12,
                            color: AppColors.muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),

                  // -- glass runner-up (screen 5a) -----------------------
                  const GlassCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Metro Computers',
                          style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        SizedBox(height: 8),
                        Text(
                          'PKR 9,100,000  ·  10 days  ·  1 year',
                          style: TextStyle(
                            fontSize: 12,
                            color: AppColors.muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),

                  // -- excluded (screen 5a) ------------------------------
                  const MutedSurface(
                    child: Text(
                      'Alpha Traders — Exceeds budget, excluded',
                      style: TextStyle(fontSize: 12, color: AppColors.muted),
                    ),
                  ),
                  const SizedBox(height: 12),

                  // -- claymorphism (screen 14d) -------------------------
                  ClayCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Price list & inventory',
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            const Expanded(
                              child: Text(
                                'Dell Latitude 5550',
                                style: TextStyle(
                                  fontSize: 13.5,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            // Recessed clay price field
                            const ClayCard(
                              recessed: true,
                              radius: AppRadii.control,
                              color: AppColors.clayRecess,
                              padding: EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 8,
                              ),
                              child: Text(
                                '174,000',
                                style: TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w700,
                                  color: AppColors.turquoise,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),

                  // -- CTA gradient --------------------------------------
                  Container(
                    height: 52,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      gradient: AppGradients.cta,
                      borderRadius: BorderRadius.circular(AppRadii.panel),
                      boxShadow: AppShadows.cta,
                    ),
                    child: const Text(
                      'Publish Updates',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/surfaces.png'),
    );
  });
}

Widget _stat(String value, String label, Color color) => Expanded(
      child: GlassCard(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              value,
              style: TextStyle(
                fontSize: 26,
                fontWeight: FontWeight.w700,
                color: color,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              label,
              style: const TextStyle(
                fontSize: 11,
                color: AppColors.muted,
                height: 1.35,
              ),
            ),
          ],
        ),
      ),
    );
