"""Scoring engine tests, driven by the exact figures in the design.

Screen 5a  -- single item: 50 laptops, budget PKR 10,000,000
Screen 11a -- mixed order: 50 laptops + 20 CPU kits + 60 docking kits,
              budget PKR 12,000,000

These are contract tests. If a change breaks them, it breaks the demo.
"""
from __future__ import annotations

from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from app.agent.scoring import registry
from app.agent.scoring.base import (
    OfferLine,
    ScoringContext,
    VendorOffer,
    VendorReliability,
)
from app.schemas.admin import ScoringWeights
from app.schemas.enums import QuoteStatus, ScoringStrategyName

TECH = UUID("11111111-1111-1111-1111-111111111111")
METRO = UUID("22222222-2222-2222-2222-222222222222")
ALPHA = UUID("33333333-3333-3333-3333-333333333333")

DEFAULT_WEIGHTS = ScoringWeights(price=0.50, delivery=0.30, warranty=0.20)

LAPTOPS = "laptops"
CPUS = "CPUs i7"
DOCKS = "docking kits"


def rel(on_time: float, accuracy: float, orders: int = 12) -> VendorReliability:
    return VendorReliability(
        has_history=True,
        orders_fulfilled=orders,
        on_time_rate=on_time,
        quantity_accuracy=accuracy,
    )


def line(
    name: str,
    qty: int,
    price: str | None,
    delivery: int | None,
    warranty: int | None,
) -> OfferLine:
    return OfferLine(
        request_item_name=name,
        quantity=qty,
        available=price is not None,
        unit_price=Decimal(price) if price else None,
        delivery_days=delivery,
        warranty_months=warranty,
    )


# ==========================================================================
# MODE A -- screen 5a
# ==========================================================================
@pytest.fixture
def single_item_context() -> ScoringContext:
    return ScoringContext(
        workflow_id=uuid4(),
        currency="PKR",
        budget=Decimal("10000000"),
        weights=DEFAULT_WEIGHTS,
        line_item_quantities={LAPTOPS: 50},
        offers=[
            VendorOffer(
                vendor_id=TECH,
                vendor_name="TechSupplies Ltd",
                lines=[line(LAPTOPS, 50, "174000", 7, 24)],
                reliability=rel(0.98, 0.99),
            ),
            VendorOffer(
                vendor_id=METRO,
                vendor_name="Metro Computers",
                lines=[line(LAPTOPS, 50, "182000", 10, 12)],
                reliability=rel(0.92, 0.96),
            ),
            VendorOffer(
                vendor_id=ALPHA,
                vendor_name="Alpha Traders",
                lines=[line(LAPTOPS, 50, "210000", 12, 12)],
                reliability=rel(0.85, 0.94),
            ),
        ],
    )


def test_selects_single_item_strategy(single_item_context):
    strategy = registry.select(single_item_context)
    assert strategy.name is ScoringStrategyName.SINGLE_ITEM


def test_design_5a_totals(single_item_context):
    """Unit price x 50 must reproduce the totals printed on the card."""
    totals = {o.vendor_name: o.total_amount for o in single_item_context.offers}
    assert totals["TechSupplies Ltd"] == Decimal("8700000.00")
    assert totals["Metro Computers"] == Decimal("9100000.00")
    assert totals["Alpha Traders"] == Decimal("10500000.00")


def test_design_5a_techsupplies_wins(single_item_context):
    result = registry.select(single_item_context).score(single_item_context)
    winner = next(q for q in result.quotes if q.id == result.selected_quote_id)
    assert winner.vendor_name == "TechSupplies Ltd"
    assert winner.status is QuoteStatus.SELECTED


def test_design_5a_alpha_excluded_on_budget(single_item_context):
    result = registry.select(single_item_context).score(single_item_context)
    alpha = next(q for q in result.quotes if q.vendor_name == "Alpha Traders")
    assert alpha.status is QuoteStatus.EXCLUDED_BUDGET
    assert alpha.exclusion_reason == "Exceeds budget — excluded"
    assert alpha.score is None, "excluded vendors are shown but never scored"


def test_excluded_vendors_are_still_returned(single_item_context):
    """Transparency: the design shows the excluded supplier, greyed out."""
    result = registry.select(single_item_context).score(single_item_context)
    assert len(result.quotes) == 3


def test_weights_label_matches_design(single_item_context):
    result = registry.select(single_item_context).score(single_item_context)
    assert result.weights_label == "Price 50% · Delivery 30% · Warranty 20%"


def test_score_components_sum_to_total(single_item_context):
    result = registry.select(single_item_context).score(single_item_context)
    for quote in result.quotes:
        if quote.score is None:
            continue
        expected = round(sum(c.contribution for c in quote.score.components), 2)
        assert quote.score.total == expected


def test_best_in_field_scores_full_marks(single_item_context):
    """TechSupplies leads on every criterion, so it scores 100."""
    result = registry.select(single_item_context).score(single_item_context)
    winner = next(q for q in result.quotes if q.vendor_name == "TechSupplies Ltd")
    assert winner.score is not None
    assert winner.score.total == pytest.approx(100.0)


def test_runner_up_is_not_zeroed(single_item_context):
    """Ratio normalisation, not min-max: the runner-up keeps a meaningful score."""
    result = registry.select(single_item_context).score(single_item_context)
    metro = next(q for q in result.quotes if q.vendor_name == "Metro Computers")
    assert metro.score is not None
    assert 60 < metro.score.total < 100


def test_justification_is_never_empty(single_item_context):
    result = registry.select(single_item_context).score(single_item_context)
    assert result.justification.strip()
    assert "TechSupplies Ltd" in result.justification


# ==========================================================================
# Data confidence
# ==========================================================================
def test_missing_warranty_reduces_confidence_not_score_silently():
    ctx = ScoringContext(
        workflow_id=uuid4(),
        currency="PKR",
        budget=Decimal("10000000"),
        weights=DEFAULT_WEIGHTS,
        line_item_quantities={LAPTOPS: 50},
        offers=[
            VendorOffer(
                vendor_id=TECH,
                vendor_name="TechSupplies Ltd",
                lines=[line(LAPTOPS, 50, "174000", 7, 24)],
                reliability=rel(0.98, 0.99),
            ),
            VendorOffer(
                vendor_id=METRO,
                vendor_name="Metro Computers",
                lines=[line(LAPTOPS, 50, "182000", 10, None)],
                reliability=rel(0.92, 0.96),
            ),
        ],
    )
    result = registry.select(ctx).score(ctx)
    metro = next(q for q in result.quotes if q.vendor_name == "Metro Computers")

    assert metro.status is not QuoteStatus.EXCLUDED_BUDGET, "never auto-exclude"
    assert metro.score is not None, "never silently drop from scoring"
    assert metro.score.confidence.percent == 80  # price 50 + delivery 30
    assert metro.score.confidence.missing_fields == ["warranty_months"]
    assert "warranty months not specified" in metro.score.confidence.label

    warranty = next(
        c for c in metro.score.components if c.criterion == "warranty"
    )
    assert warranty.was_imputed is True
    assert warranty.normalised == 0.5  # neutral, not zero


def test_new_vendor_has_no_history_and_is_flagged():
    ctx = ScoringContext(
        workflow_id=uuid4(),
        currency="PKR",
        budget=Decimal("10000000"),
        weights=DEFAULT_WEIGHTS,
        line_item_quantities={LAPTOPS: 50},
        offers=[
            VendorOffer(
                vendor_id=TECH,
                vendor_name="Fresh Imports",
                lines=[line(LAPTOPS, 50, "170000", 8, 24)],
                reliability=VendorReliability(has_history=False),
            ),
        ],
    )
    result = registry.select(ctx).score(ctx)
    quote = result.quotes[0]
    assert quote.reliability.display == "No history yet"
    assert quote.reliability.score is None
    assert any("no fulfilment history" in c for c in result.caveats)


def test_no_qualifying_vendor_yields_no_selection():
    """Zero in-budget vendors must not silently pick one -- the graph branches."""
    ctx = ScoringContext(
        workflow_id=uuid4(),
        currency="PKR",
        budget=Decimal("1000000"),
        weights=DEFAULT_WEIGHTS,
        line_item_quantities={LAPTOPS: 50},
        offers=[
            VendorOffer(
                vendor_id=TECH,
                vendor_name="TechSupplies Ltd",
                lines=[line(LAPTOPS, 50, "174000", 7, 24)],
                reliability=rel(0.98, 0.99),
            ),
        ],
    )
    result = registry.select(ctx).score(ctx)
    assert result.selected_quote_id is None
    assert "human review" in result.justification.lower()


# ==========================================================================
# MODE B -- screen 11a
# ==========================================================================
@pytest.fixture
def multi_item_context() -> ScoringContext:
    return ScoringContext(
        workflow_id=uuid4(),
        currency="PKR",
        budget=Decimal("12000000"),
        weights=DEFAULT_WEIGHTS,
        line_item_quantities={LAPTOPS: 50, CPUS: 20, DOCKS: 60},
        offers=[
            VendorOffer(
                vendor_id=TECH,
                vendor_name="TechSupplies Ltd",
                lines=[
                    line(LAPTOPS, 50, "174000", 7, 24),
                    line(CPUS, 20, "96000", 7, 24),
                    line(DOCKS, 60, "11500", 7, 24),
                ],
                reliability=rel(0.98, 0.99),
            ),
            VendorOffer(
                vendor_id=METRO,
                vendor_name="Metro Computers",
                lines=[
                    line(LAPTOPS, 50, "182000", 10, 12),
                    line(CPUS, 20, None, None, None),      # "Not stocked"
                    line(DOCKS, 60, "11000", 10, 12),
                ],
                reliability=rel(0.92, 0.96),
            ),
            # The design prints only Alpha's order total (12,840,000). These
            # line prices are chosen to reproduce it exactly while staying
            # plausible against the other two vendors:
            #   50 x 210,000 + 20 x 87,000 + 60 x 10,000 = 12,840,000
            VendorOffer(
                vendor_id=ALPHA,
                vendor_name="Alpha Traders",
                lines=[
                    line(LAPTOPS, 50, "210000", 12, 12),
                    line(CPUS, 20, "87000", 12, 12),
                    line(DOCKS, 60, "10000", 12, 12),
                ],
                reliability=rel(0.85, 0.94),
            ),
        ],
    )


def test_selects_multi_item_strategy(multi_item_context):
    assert registry.select(multi_item_context).name is ScoringStrategyName.MULTI_ITEM


def test_design_11a_totals(multi_item_context):
    totals = {o.vendor_name: o.total_amount for o in multi_item_context.offers}
    assert totals["TechSupplies Ltd"] == Decimal("11310000.00")
    assert totals["Metro Computers"] == Decimal("9760000.00")   # partial, 2/3
    assert totals["Alpha Traders"] == Decimal("12840000.00")


def test_design_11a_coverage_labels(multi_item_context):
    result = registry.select(multi_item_context).score(multi_item_context)
    by_name = {q.vendor_name: q for q in result.quotes}

    assert by_name["TechSupplies Ltd"].coverage_label == "Covers 3/3 items"
    assert by_name["TechSupplies Ltd"].is_partial is False

    metro = by_name["Metro Computers"]
    assert metro.items_covered == 2
    assert metro.coverage_label == f"Covers 2/3 — no {CPUS}"
    assert metro.is_partial is True, "partial totals are asterisked in the design"


def test_design_11a_techsupplies_selected(multi_item_context):
    result = registry.select(multi_item_context).score(multi_item_context)
    winner = next(q for q in result.quotes if q.id == result.selected_quote_id)
    assert winner.vendor_name == "TechSupplies Ltd"
    assert result.selected_scenario_key == f"single:{TECH}"


def test_design_11a_alpha_over_budget(multi_item_context):
    result = registry.select(multi_item_context).score(multi_item_context)
    alpha = next(q for q in result.quotes if q.vendor_name == "Alpha Traders")
    assert alpha.status is QuoteStatus.EXCLUDED_BUDGET


def test_design_11a_partial_vendor_cannot_win(multi_item_context):
    """Metro is cheapest overall but covers 2/3 -- it must never be selected."""
    result = registry.select(multi_item_context).score(multi_item_context)
    metro = next(q for q in result.quotes if q.vendor_name == "Metro Computers")
    assert metro.status is QuoteStatus.EXCLUDED_COVERAGE
    assert result.selected_quote_id != metro.id


def test_split_scenario_is_evaluated_and_loses_on_lead_time(multi_item_context):
    """A split saves real money but waits for its slowest leg.

    Cheapest-per-line is TechSupplies (laptops) + Alpha (CPUs + docks):
        8,700,000 + 1,740,000 + 600,000    = 11,040,000
      + 25,000 overhead for the second PO  = 11,065,000
    versus TechSupplies alone at 11,310,000 -- 245,000 cheaper, but it
    stretches delivery from 7 to 12 days and drops warranty cover from 24 to
    12 months. Weighted 50/30/20, the single PO must still win.
    """
    result = registry.select(multi_item_context).score(multi_item_context)
    split = next(s for s in result.scenarios if s.is_split)

    assert split.goods_total == Decimal("11040000.00")
    assert split.po_overhead == Decimal("25000")
    assert split.effective_total == Decimal("11065000.00")
    assert split.lead_time_days == 12
    assert split.extra_lead_days_vs_best_single == 5
    assert split.savings_vs_best_single == Decimal("245000.00")

    single = next(s for s in result.scenarios if not s.is_split)
    assert single.score > split.score
    assert result.selected_scenario_key == single.key


def test_over_budget_vendor_can_still_supply_part_of_a_split(multi_item_context):
    """Budget exclusion applies to a vendor's WHOLE-ORDER quote, not to it as
    a supplier of individual lines.

    Alpha's full basket is 12,840,000 -- over the 12,000,000 ceiling, so its
    quote card is excluded. But its CPUs and docks together cost 2,340,000,
    and the split scenario is free to use them. Conflating the two would
    silently discard a legitimate option.
    """
    result = registry.select(multi_item_context).score(multi_item_context)

    alpha_quote = next(q for q in result.quotes if q.vendor_name == "Alpha Traders")
    assert alpha_quote.status is QuoteStatus.EXCLUDED_BUDGET

    split = next(s for s in result.scenarios if s.is_split)
    suppliers = {a.vendor_name for a in split.allocations}
    assert suppliers == {"TechSupplies Ltd", "Alpha Traders"}
    assert split.within_budget is True


def test_design_11a_justification_mentions_the_tradeoff(multi_item_context):
    result = registry.select(multi_item_context).score(multi_item_context)
    text = result.justification
    assert "TechSupplies Ltd" in text
    assert "3 line items" in text
    assert "94% of budget" in text          # 11,310,000 / 12,000,000
    assert "purchase order" in text.lower()


def test_scenarios_are_ranked_in_budget_first(multi_item_context):
    result = registry.select(multi_item_context).score(multi_item_context)
    in_budget = [s.within_budget for s in result.scenarios]
    assert in_budget == sorted(in_budget, reverse=True)


# ==========================================================================
# Configurability -- no magic numbers
# ==========================================================================
def test_weights_must_sum_to_one():
    with pytest.raises(ValueError, match="must sum to 1.0"):
        ScoringWeights(price=0.5, delivery=0.3, warranty=0.5)


def test_reweighting_changes_the_winner():
    """Admin-configurable weights genuinely drive the outcome."""
    offers = [
        VendorOffer(
            vendor_id=TECH,
            vendor_name="Cheap but slow",
            lines=[line(LAPTOPS, 10, "100000", 30, 12)],
            reliability=rel(0.9, 0.95),
        ),
        VendorOffer(
            vendor_id=METRO,
            vendor_name="Dear but fast",
            lines=[line(LAPTOPS, 10, "130000", 2, 12)],
            reliability=rel(0.9, 0.95),
        ),
    ]

    def winner_with(weights: ScoringWeights) -> str:
        ctx = ScoringContext(
            workflow_id=uuid4(),
            currency="PKR",
            budget=Decimal("2000000"),
            weights=weights,
            line_item_quantities={LAPTOPS: 10},
            offers=offers,
        )
        result = registry.select(ctx).score(ctx)
        return next(
            q.vendor_name for q in result.quotes if q.id == result.selected_quote_id
        )

    assert winner_with(ScoringWeights(price=0.9, delivery=0.05, warranty=0.05)) == "Cheap but slow"
    assert winner_with(ScoringWeights(price=0.05, delivery=0.9, warranty=0.05)) == "Dear but fast"


def test_registry_exposes_both_modes():
    assert set(registry.available()) >= {
        ScoringStrategyName.SINGLE_ITEM,
        ScoringStrategyName.MULTI_ITEM,
    }


def test_registry_rejects_duplicate_registration():
    from app.agent.scoring.single_item import SingleItemScoringStrategy

    with pytest.raises(ValueError, match="already registered"):
        registry.register(SingleItemScoringStrategy())
