"""Normalisation and data-confidence helpers.

Normalisation is RATIO-based, not min-max, for two reasons:

  1. Min-max collapses to {0.0, 1.0} whenever only two vendors qualify -- which
     is exactly the demo case. That makes the score bar meaningless and the
     runner-up look worthless.
  2. A ratio is interpretable in the justification: "4% dearer than the
     cheapest" is a sentence a human can check; "normalised 0.0" is not.

For lower-is-better criteria (price, delivery) the score is best/actual.
For higher-is-better criteria (warranty, reliability) it is actual/best.
Both land in (0, 1] with 1.0 meaning "best in this field".

MISSING DATA: a vendor that omits delivery_days or warranty_months is never
silently penalised and never auto-excluded. The criterion is imputed at
``settings.scoring.missing_field_neutral_score`` and the imputation is
recorded, so the UI can show a reduced data-confidence percentage and name the
field that was absent.
"""
from __future__ import annotations

from decimal import Decimal

from app.core.config import settings
from app.schemas.quote import DataConfidence, ScoreComponent

# Criteria that contribute to the weighted score, in display order.
CRITERIA: tuple[str, ...] = ("price", "delivery", "warranty", "reliability")

# Criteria whose absence is a data-confidence problem. Price is not in this
# set: an offer with no price is not a quote at all and never reaches scoring.
OPTIONAL_CRITERIA: tuple[str, ...] = ("delivery", "warranty")

_CRITERION_TO_FIELD = {
    "delivery": "delivery_days",
    "warranty": "warranty_months",
    "reliability": "reliability",
}


def ratio_lower_is_better(value: float | None, best: float | None) -> float | None:
    """best/actual, clamped to (0, 1]. None propagates."""
    if value is None or best is None:
        return None
    if value <= 0:
        return 1.0
    return max(0.0, min(1.0, best / value))


def ratio_higher_is_better(value: float | None, best: float | None) -> float | None:
    """actual/best, clamped to [0, 1]. None propagates."""
    if value is None or best is None:
        return None
    if best <= 0:
        return 1.0
    return max(0.0, min(1.0, value / best))


def _to_float(value: Decimal | float | int | None) -> float | None:
    return None if value is None else float(value)


def build_components(
    *,
    total_amount: Decimal | float | None,
    delivery_days: int | None,
    warranty_months: int | None,
    reliability_star: float | None,
    best_total: Decimal | float | None,
    best_delivery: int | None,
    best_warranty: int | None,
    weights: dict[str, float],
) -> list[ScoreComponent]:
    """Turn one vendor's raw figures into weighted, imputation-aware components."""
    neutral = settings.scoring.missing_field_neutral_score
    new_vendor_neutral = settings.scoring.new_vendor_neutral_reliability

    raw: dict[str, float | None] = {
        "price": _to_float(total_amount),
        "delivery": _to_float(delivery_days),
        "warranty": _to_float(warranty_months),
        "reliability": reliability_star,
    }
    normalised: dict[str, float | None] = {
        "price": ratio_lower_is_better(raw["price"], _to_float(best_total)),
        "delivery": ratio_lower_is_better(raw["delivery"], _to_float(best_delivery)),
        "warranty": ratio_higher_is_better(raw["warranty"], _to_float(best_warranty)),
        # Reliability is scored against the 5-star ceiling, not against the
        # best vendor -- otherwise a field of poor performers would make the
        # least-bad one look excellent.
        "reliability": ratio_higher_is_better(reliability_star, 5.0),
    }

    components: list[ScoreComponent] = []
    for criterion in CRITERIA:
        weight = weights.get(criterion, 0.0)
        if weight <= 0:
            continue
        value = normalised[criterion]
        imputed = value is None
        if imputed:
            value = new_vendor_neutral if criterion == "reliability" else neutral
        components.append(
            ScoreComponent(
                criterion=criterion,
                raw_value=raw[criterion],
                normalised=round(value, 6),
                weight=weight,
                was_imputed=imputed,
            )
        )
    return components


def total_score(components: list[ScoreComponent]) -> float:
    """Weighted total out of 100 -- the number beside the bar in the design."""
    return round(sum(c.contribution for c in components), 2)


def build_confidence(components: list[ScoreComponent]) -> DataConfidence:
    """Confidence = share of weight backed by real vendor-supplied data.

    Reproduces the design's copy target, e.g. a vendor that specified price
    and delivery but not warranty scores 50% + 30% = 80% of the weight on real
    data. With the default weights, a missing warranty gives 80%; a missing
    delivery gives 70%.
    """
    if not components:
        return DataConfidence(percent=0, missing_fields=[], scored_on=[])

    total_weight = sum(c.weight for c in components)
    real_weight = sum(c.weight for c in components if not c.was_imputed)
    percent = (
        int(round(real_weight / total_weight * 100)) if total_weight > 0 else 0
    )

    missing = [
        _CRITERION_TO_FIELD.get(c.criterion, c.criterion)
        for c in components
        if c.was_imputed and c.criterion in OPTIONAL_CRITERIA
    ]
    scored_on = [c.criterion for c in components if not c.was_imputed]
    return DataConfidence(
        percent=percent, missing_fields=missing, scored_on=scored_on
    )
