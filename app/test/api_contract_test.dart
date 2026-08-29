/// Contract tests: the Dart models against REAL backend responses.
///
/// The fixtures in test/fixtures/ were captured from a live run of the API
/// against the seeded Supabase project -- they are not hand-written. If the
/// backend changes a field name or type, these fail, which is the whole point:
/// the app and the API cannot drift silently.
///
/// Re-capture with the snippet in scripts/ (see the backend README).
library;

import 'dart:convert';
import 'dart:io';

import 'package:agentflow/api/models.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _json(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync())
        as Map<String, dynamic>;

List<dynamic> _jsonList(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync()) as List<dynamic>;

void main() {
  group('workflow list (screen 10a)', () {
    test('parses a real page', () {
      final page = Paged.fromJson(_json('workflows_page.json'),
          WorkflowSummary.fromJson);
      expect(page.items, isNotEmpty);
      expect(page.total, greaterThan(0));

      final done =
          page.items.firstWhere((w) => w.status == WorkflowStatus.completed);
      expect(done.title, contains('Laptop procurement'));
      // The design's pill copy, not the raw enum.
      expect(done.status.label, 'Done');
      expect(done.durationMs, isNotNull);
    });

    test('maps every backend status to a design pill label', () {
      final page = Paged.fromJson(_json('workflows_page.json'),
          WorkflowSummary.fromJson);
      for (final w in page.items) {
        expect(w.status.label, isNotEmpty);
        // A raw enum name leaking into the UI would be a bug.
        expect(w.status.label, isNot(contains('_')));
      }
    });
  });

  group('workflow detail (screens 3a/4a)', () {
    test('parses all eight steps with their tool calls', () {
      final wf = WorkflowDetail.fromJson(_json('workflow_detail.json'));
      expect(wf.steps, hasLength(8));
      expect(wf.progressPercent, 100);
      expect(
        wf.steps.map((s) => s.name).toList(),
        [
          'create_request', 'fetch_quotes', 'budget_filter', 'score_rank',
          'select_best', 'generate_po', 'validate_po', 'route_approval',
        ],
      );
      // Tool calls hang off their step for the expanded log on 4a.
      final fetch = wf.steps.firstWhere((s) => s.name == 'fetch_quotes');
      expect(fetch.toolCalls, isNotEmpty);
      expect(fetch.toolCalls.first.toolName, 'catalog_query');
      expect(fetch.toolCalls.first.logLine, contains('ms'));
    });

    test('every completed step has a duration', () {
      final wf = WorkflowDetail.fromJson(_json('workflow_detail.json'));
      for (final s in wf.steps.where(
        (s) => s.status == StepStatus.completed,
      )) {
        expect(s.durationMs, isNotNull, reason: '${s.name} has no duration');
      }
    });
  });

  group('single-item comparison (screen 5a)', () {
    late List<Quote> quotes;

    setUpAll(() {
      quotes = ((_json('comparison_single.json')['quotes'] as List))
          .map((e) => Quote.fromJson(e as Map<String, dynamic>))
          .toList();
    });

    test('reproduces the design figures', () {
      final tech = quotes.firstWhere((q) => q.vendorName == 'TechSupplies Ltd');
      final metro = quotes.firstWhere((q) => q.vendorName == 'Metro Computers');
      final alpha = quotes.firstWhere((q) => q.vendorName == 'Alpha Traders');

      expect(tech.totalAmount, 8700000);
      expect(tech.deliveryDays, 7);
      expect(tech.warrantyMonths, 24);
      expect(metro.totalAmount, 9100000);
      expect(alpha.totalAmount, 10500000);
    });

    test('winner is selected and the over-budget vendor is excluded', () {
      final tech = quotes.firstWhere((q) => q.vendorName == 'TechSupplies Ltd');
      expect(tech.isSelected, isTrue);
      expect(tech.scoreTotal, 100.0);

      final alpha = quotes.firstWhere((q) => q.vendorName == 'Alpha Traders');
      expect(alpha.status, QuoteStatus.excludedBudget);
      expect(alpha.status.isExcluded, isTrue);
      expect(alpha.exclusionReason, contains('Exceeds budget'));
      // Excluded vendors are shown but never scored.
      expect(alpha.scoreTotal, isNull);
    });

    test('reliability renders the design star, never fabricated', () {
      final tech = quotes.firstWhere((q) => q.vendorName == 'TechSupplies Ltd');
      expect(tech.reliabilityLabel, '4.8');
      final metro = quotes.firstWhere((q) => q.vendorName == 'Metro Computers');
      expect(metro.reliabilityLabel, '4.5');
    });

    test('score components sum to the total for the stacked bar', () {
      final tech = quotes.firstWhere((q) => q.vendorName == 'TechSupplies Ltd');
      expect(tech.components, hasLength(3)); // price, delivery, warranty
      final sum = tech.components.fold<double>(0, (s, c) => s + c.contribution);
      expect(sum, closeTo(tech.scoreTotal!, 0.01));
    });
  });

  group('multi-item comparison (screen 11a)', () {
    late List<Quote> quotes;

    setUpAll(() {
      quotes = ((_json('comparison_multi.json')['quotes'] as List))
          .map((e) => Quote.fromJson(e as Map<String, dynamic>))
          .toList();
    });

    test('reproduces the design coverage labels', () {
      final tech = quotes.firstWhere((q) => q.vendorName == 'TechSupplies Ltd');
      expect(tech.totalAmount, 11310000);
      expect(tech.coverageLabel, 'Covers 3/3 items');
      expect(tech.isPartial, isFalse);

      final metro = quotes.firstWhere((q) => q.vendorName == 'Metro Computers');
      expect(metro.itemsCovered, 2);
      expect(metro.itemsRequested, 3);
      expect(metro.isPartial, isTrue);
      // The design's exact phrasing.
      expect(metro.coverageLabel, contains('Covers 2/3'));
      expect(metro.coverageLabel, contains('no CPU kit'));
    });

    test('an unavailable line renders as Not stocked', () {
      final metro = quotes.firstWhere((q) => q.vendorName == 'Metro Computers');
      final cpu = metro.lines.firstWhere((l) => l.requestItemName == 'CPU kit');
      expect(cpu.available, isFalse);
      expect(cpu.unitPrice, isNull);
    });

    test('the winning PO has three priced lines', () {
      final tech = quotes.firstWhere((q) => q.vendorName == 'TechSupplies Ltd');
      final priced = tech.lines.where((l) => l.available).toList();
      expect(priced, hasLength(3));
      expect(
        priced.map((l) => l.lineTotal).toList(),
        containsAll(<double>[8700000, 1920000, 690000]),
      );
    });
  });

  group('validation (screens 6a/6b)', () {
    test('parses a passing report', () {
      final r = ValidationReport.fromJson(_json('validation.json'));
      expect(r.passed, isTrue);
      expect(r.checks, hasLength(5));
      expect(r.summaryLabel, '5 of 5 checks passed');
      expect(r.failures, isEmpty);
      expect(r.canSelfCorrect, isFalse);
    });

    test('every check carries an expected/actual pair', () {
      final r = ValidationReport.fromJson(_json('validation.json'));
      for (final c in r.checks) {
        expect(c.message, isNotEmpty);
        // 6b needs both to explain a failure.
        expect(c.expected, isNotNull, reason: c.title);
        expect(c.actual, isNotNull, reason: c.title);
      }
    });
  });

  group('purchase order (screen 7a)', () {
    test('parses and totals correctly', () {
      final po = PurchaseOrder.fromJson(_json('purchase_order.json'));
      expect(po.poNumber, startsWith('PO-'));
      expect(po.totalAmount, 8700000);
      expect(po.subtotal + po.tax, po.totalAmount);
      expect(po.lineItems, isNotEmpty);
      expect(po.totalUnits, 50);
      expect(po.deliveryStatus, PODeliveryStatus.issued);
      expect(po.deliveryStatus.label, 'Issued');
    });
  });

  group('report and audit (screens 9a/10b)', () {
    test('report carries metrics and sections', () {
      final r = CompletionReport.fromJson(_json('report.json'));
      expect(r.headline, isNotEmpty);
      expect(r.metrics, isNotEmpty);
      expect(r.stepsExecuted, 8);
      expect(r.toolsInvoked, greaterThan(0));
      expect(
        r.metrics.map((m) => m.label),
        contains('Order total'),
      );
    });

    test('audit trail is chronological', () {
      final events = _jsonList('audit.json')
          .map((e) => AuditEvent.fromJson(e as Map<String, dynamic>))
          .toList();
      expect(events, isNotEmpty);
      for (var i = 1; i < events.length; i++) {
        expect(
          events[i].at.isBefore(events[i - 1].at),
          isFalse,
          reason: 'audit events must be ordered oldest-first',
        );
      }
      expect(events.map((e) => e.source), contains('tool_call'));
    });
  });

  group('vendors (screens 13a/18a)', () {
    test('parses the four seeded vendors', () {
      final page =
          Paged.fromJson(_json('vendors_page.json'), Vendor.fromJson);
      expect(page.items, hasLength(4));
      final names = page.items.map((v) => v.name).toList();
      expect(names, containsAll(<String>[
        'TechSupplies Ltd',
        'Metro Computers',
        'Alpha Traders',
        'Fresh Imports',
      ]));
    });

    test('a new vendor reports no history rather than a fake rating', () {
      final page =
          Paged.fromJson(_json('vendors_page.json'), Vendor.fromJson);
      final fresh = page.items.firstWhere((v) => v.name == 'Fresh Imports');
      expect(fresh.reliability.hasHistory, isFalse);
      expect(fresh.reliability.display, 'No history yet');
      expect(fresh.reliability.score, isNull);
    });

    test('the flagged vendor surfaces the agent flag (18a)', () {
      final page =
          Paged.fromJson(_json('vendors_page.json'), Vendor.fromJson);
      final metro = page.items.firstWhere((v) => v.name == 'Metro Computers');
      expect(metro.isFlagged, isTrue);
      expect(metro.flags.first.detail, contains('late deliveries'));
      expect(metro.flags.first.detail, contains('flagged by agent'));
    });
  });

  group('catalog (screens 14a/15a)', () {
    test('vendor sees its own catalog and draft state', () {
      final data = _json('catalog_me.json');
      final items = (data['items'] as List)
          .map((e) => CatalogItem.fromJson(e as Map<String, dynamic>))
          .toList();
      final draft = CatalogDraftState.fromJson(
        data['draft_state'] as Map<String, dynamic>,
      );

      expect(items, isNotEmpty);
      // The design's status line format.
      expect(draft.statusLine, contains('Last published'));
      expect(draft.statusLine, contains('unsaved changes'));
    });

    test('the low-stock badge is driven by the backend flag', () {
      final items = (_json('catalog_me.json')['items'] as List)
          .map((e) => CatalogItem.fromJson(e as Map<String, dynamic>))
          .toList();
      final low = items.where((i) => i.isLowStock).toList();
      expect(low, isNotEmpty, reason: 'screen 14a needs a Low stock row');
      expect(low.every((i) => i.stock <= 20), isTrue);
    });

    test('browse returns published items with vendor names', () {
      final items = (_json('catalog_browse.json')['items'] as List)
          .map((e) => CatalogItem.fromJson(e as Map<String, dynamic>))
          .toList();
      expect(items, isNotEmpty);
      expect(items.every((i) => i.vendorName != null), isTrue);
      expect(items.every((i) => i.publishedAt != null), isTrue);
    });
  });

  group('admin (screen 17a)', () {
    test('dashboard parses its stat tiles', () {
      final d = AdminDashboard.fromJson(_json('admin_dashboard.json'));
      expect(d.stats, hasLength(4));
      expect(
        d.stats.map((s) => s.key),
        containsAll(<String>[
          'active_workflows',
          'pending_approvals',
          'completed',
          'flagged_vendors',
        ]),
      );
    });

    test('scoring weights carry the design label', () {
      final w = ScoringWeights.fromJson(_json('scoring_weights.json'));
      expect(w.price, 0.5);
      expect(w.delivery, 0.3);
      expect(w.warranty, 0.2);
      expect(w.label, 'Price 50% · Delivery 30% · Warranty 20%');
    });
  });

  group('approvals (screen 8a)', () {
    test('pending approvals parse with their PO totals', () {
      final page =
          Paged.fromJson(_json('approvals_page.json'), Approval.fromJson);
      for (final a in page.items) {
        expect(a.isPending, isTrue);
        expect(a.workflowId, isNotEmpty);
      }
    });
  });

  group('vendor purchase orders', () {
    test('parse for the delivery-status screen', () {
      final page =
          Paged.fromJson(_json('vendor_pos.json'), PurchaseOrder.fromJson);
      for (final po in page.items) {
        expect(po.poNumber, startsWith('PO-'));
        expect(po.deliveryStatus.label, isNotEmpty);
      }
    });
  });
}
