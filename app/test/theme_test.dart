/// Contract tests for the design tokens.
///
/// These assert that the values in `tokens.dart` still equal the ones in
/// AgentFlow.dc.html. If a refactor drifts a colour or a radius, this fails
/// rather than the drift shipping unnoticed.
library;

import 'package:agentflow/theme/surfaces.dart';
import 'package:agentflow/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('vendor palette', () {
    test('matches the brief exactly', () {
      expect(AppColors.turquoise, const Color(0xFF447F98));
      expect(AppColors.slate, const Color(0xFF629BB5));
      expect(AppColors.platinum, const Color(0xFFDADEE1));
      expect(AppColors.glacier, const Color(0xFFB9D8E1));
      expect(AppColors.ice, const Color(0xFFD6EBF3));
    });

    test('text colours match the design', () {
      // The three most-used text colours in AgentFlow.dc.html.
      expect(AppColors.subtle, const Color(0xFF7E8C94)); // 115 uses
      expect(AppColors.muted, const Color(0xFF5F7280)); //  95 uses
      expect(AppColors.ink, const Color(0xFF243640)); //  39 uses
    });

    test('status colours match the design pills', () {
      expect(AppColors.successBg, const Color(0xFFECFDF3));
      expect(AppColors.successFg, const Color(0xFF067647));
      expect(AppColors.successSolid, const Color(0xFF17B26A));
      expect(AppColors.warningBg, const Color(0xFFFFFAEB));
      expect(AppColors.warningFg, const Color(0xFFB54708));
      expect(AppColors.dangerBg, const Color(0xFFFEF3F2));
      expect(AppColors.dangerFg, const Color(0xFFB42318));
    });
  });

  group('scales', () {
    test('radii match the design', () {
      expect(AppRadii.card, 28.0); // 36 uses, the dominant card radius
      expect(AppRadii.clayCard, 30.0); // screen 14d
      expect(AppRadii.panel, 24.0);
      expect(AppRadii.control, 16.0);
    });

    test('blur values match the backdrop-filter declarations', () {
      expect(AppBlurs.card, 26.0);
      expect(AppBlurs.cardSaturation, 1.7);
      expect(AppBlurs.nav, 20.0);
      expect(AppBlurs.soft, 14.0);
      expect(AppBlurs.chip, 12.0);
    });

    test('type scale includes the design half-sizes', () {
      // The design genuinely uses 13.5px and 11.5px; they are not rounded.
      expect(AppTypeScale.listTitle, 13.5);
      expect(AppTypeScale.chip, 11.5);
      expect(AppTypeScale.badge, 10.5);
      expect(AppTypeScale.nano, 9.5);
    });
  });

  group('shadow recipes', () {
    test('glass card shadow matches 0 20px 44px rgba(46,96,120,.24)', () {
      final s = AppShadows.glassCard.single;
      expect(s.offset, const Offset(0, 20));
      expect(s.blurRadius, 44);
      // .24 alpha of rgb(46,96,120)
      expect(s.color.a, closeTo(0.24, 0.01));
    });

    test('clay card shadow matches 0 22px 30px rgba(68,127,152,.16)', () {
      final s = AppShadows.clayCard.single;
      expect(s.offset, const Offset(0, 22));
      expect(s.blurRadius, 30);
      expect(s.color.a, closeTo(0.16, 0.01));
    });
  });

  group('surfaces render', () {
    Future<void> pump(WidgetTester tester, Widget child) => tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: PageBackground(child: Center(child: child)),
            ),
          ),
        );

    testWidgets('GlassCard builds with a backdrop filter', (tester) async {
      await pump(tester, const GlassCard(child: Text('glass')));
      expect(find.text('glass'), findsOneWidget);
      // The blur is what makes it "liquid glass" rather than a white box.
      expect(find.byType(BackdropFilter), findsOneWidget);
    });

    testWidgets('ClayCard builds WITHOUT a backdrop filter', (tester) async {
      await pump(tester, const ClayCard(child: Text('clay')));
      expect(find.text('clay'), findsOneWidget);
      // Clay is opaque by definition -- a blur here would be wrong.
      expect(find.byType(BackdropFilter), findsNothing);
    });

    testWidgets('recessed ClayCard drops its outer shadow', (tester) async {
      await pump(
        tester,
        const ClayCard(recessed: true, child: Text('recessed')),
      );
      final decorated = tester
          .widgetList<DecoratedBox>(find.byType(DecoratedBox))
          .map((d) => d.decoration)
          .whereType<BoxDecoration>()
          .toList();
      // A pressed-in surface casts nothing outward.
      expect(
        decorated.any((d) => (d.boxShadow ?? const []).isEmpty),
        isTrue,
      );
    });

    testWidgets('OutlinedSurface uses the Best Option green', (tester) async {
      await pump(tester, const OutlinedSurface(child: Text('winner')));
      final container = tester.widget<Container>(
        find
            .descendant(
              of: find.byType(OutlinedSurface),
              matching: find.byType(Container),
            )
            .first,
      );
      final decoration = container.decoration! as BoxDecoration;
      expect(decoration.border!.top.color, AppColors.successSolid);
      expect(decoration.border!.top.width, 1.5);
    });

    testWidgets('MutedSurface is de-emphasised', (tester) async {
      await pump(tester, const MutedSurface(child: Text('excluded')));
      final opacity = tester.widget<Opacity>(find.byType(Opacity).first);
      expect(opacity.opacity, 0.8);
    });
  });
}
