"""MODE A -- single-item scoring. Design screen 5a.

Pipeline:
    1. Split offers into qualifying and budget-excluded.
    2. Normalise each qualifying offer against the best value in each field.
    3. Weight, sum, attach data confidence.
    4. Rank; the top score wins.

Budget-excluded vendors are still returned, scored ``None``, carrying the
exact exclusion copy from the design ("Exceeds budget -- excluded"). They are
shown, never hidden -- transparency is the point of the screen.
"""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from app.agent.scoring.base import ScoringContext, ScoringStrategy, VendorOffer
from app.agent.scoring.normalizers import (
    build_components,
    build_confidence,
    total_score,
)
from app.schemas.enums import QuoteStatus, ScoringStrategyName
from app.schemas.quote import (
    QuoteLine,
    QuoteRead,
    ReliabilityBlock,
    ScoreBreakdown,
    SingleItemComparison,
)

EXCEEDS_BUDGET = "Exceeds budget — excluded"
NO_PRICE = "No price available — excluded"


def reliability_block(offer: VendorOffer) -> ReliabilityBlock:
    r = offer.reliability
    return ReliabilityBlock(
        has_history=r.has_history,
        orders_fulfilled=r.orders_fulfilled,
        on_time_rate=r.on_time_rate,
        quantity_accuracy=r.quantity_accuracy,
        cancellations=r.cancellations,
        late_deliveries=r.late_deliveries,
        score=r.star_score,
        display=r.display,
    )


def quote_lines(offer: VendorOffer) -> list[QuoteLine]:
    return [
        QuoteLine(
            request_item_name=ln.request_item_name,
            catalog_item_id=ln.catalog_item_id,
            sku=ln.sku,
            matched_title=ln.matched_title,
            quantity=ln.quantity,
            available=ln.available,
            stock_on_hand=ln.stock_on_hand,
            unit_price=ln.unit_price,
            line_total=ln.line_total,
            delivery_days=ln.delivery_days,
            warranty_months=ln.warranty_months,
        )
        for ln in offer.lines
    ]


def is_within_budget(total: Decimal | None, budget: Decimal | None) -> bool:
    if total is None:
        return False
    if budget is None:
        return True
    return total <= budget


class SingleItemScoringStrategy(ScoringStrategy):
    """Weighted multi-criteria ranking for a one-line-item request."""

    name = ScoringStrategyName.SINGLE_ITEM

    def supports(self, context: ScoringContext) -> bool:
        return not context.is_multi_item

    def score(self, context: ScoringContext) -> SingleItemComparison:
        now = context.computed_at or datetime.now(UTC)
        weights = context.weights.as_dict()

        qualifying: list[VendorOffer] = []
        excluded: list[tuple[VendorOffer, str]] = []

        for offer in context.offers:
            total = offer.total_amount
            if total is None:
                excluded.append((offer, NO_PRICE))
            elif not is_within_budget(total, context.budget):
                excluded.append((offer, EXCEEDS_BUDGET))
            else:
                qualifying.append(offer)

        # Best-in-field references, computed over qualifying offers only.
        best_total = min(
            (o.total_amount for o in qualifying if o.total_amount is not None),
            default=None,
        )
        best_delivery = min(
            (o.delivery_days for o in qualifying if o.delivery_days is not None),
            default=None,
        )
        best_warranty = max(
            (o.warranty_months for o in qualifying if o.warranty_months is not None),
            default=None,
        )

        scored: list[QuoteRead] = []
        for offer in qualifying:
            components = build_components(
                total_amount=offer.total_amount,
                delivery_days=offer.delivery_days,
                warranty_months=offer.warranty_months,
                reliability_star=offer.reliability.star_score,
                best_total=best_total,
                best_delivery=best_delivery,
                best_warranty=best_warranty,
                weights=weights,
            )
            scored.append(
                self._quote(
                    context,
                    offer,
                    now,
                    status=QuoteStatus.QUOTED,
                    breakdown=ScoreBreakdown(
                        total=total_score(components),
                        components=components,
                        confidence=build_confidence(components),
                    ),
                )
            )

        scored.sort(key=lambda q: q.score.total if q.score else -1.0, reverse=True)

        winner = scored[0] if scored else None
        if winner is not None:
            winner.status = QuoteStatus.SELECTED

        for offer, reason in excluded:
            scored.append(
                self._quote(
                    context,
                    offer,
                    now,
                    status=(
                        QuoteStatus.EXCLUDED_BUDGET
                        if reason == EXCEEDS_BUDGET
                        else QuoteStatus.EXCLUDED_STOCK
                    ),
                    breakdown=None,
                    exclusion_reason=reason,
                )
            )

        item_name = context.item_names[0] if context.item_names else "item"
        quantity = context.line_item_quantities.get(item_name) or (
            context.offers[0].lines[0].quantity if context.offers and context.offers[0].lines else 1
        )

        return SingleItemComparison(
            workflow_id=context.workflow_id,
            strategy=self.name,
            currency=context.currency,
            budget=context.budget,
            weights=weights,
            weights_label=context.weights.label,
            quotes=scored,
            selected_quote_id=winner.id if winner else None,
            justification=self._fallback_justification(winner, context),
            caveats=self._caveats(winner, qualifying),
            computed_at=now,
            item_name=item_name,
            quantity=quantity,
        )

    # -- helpers -------------------------------------------------------
    def _quote(
        self,
        context: ScoringContext,
        offer: VendorOffer,
        now: datetime,
        *,
        status: QuoteStatus,
        breakdown: ScoreBreakdown | None,
        exclusion_reason: str | None = None,
    ) -> QuoteRead:
        return QuoteRead(
            id=offer.vendor_id,
            workflow_id=context.workflow_id,
            vendor_id=offer.vendor_id,
            vendor_name=offer.vendor_name,
            status=status,
            lines=quote_lines(offer),
            total_amount=offer.total_amount,
            currency=context.currency,
            delivery_days=offer.delivery_days,
            warranty_months=offer.warranty_months,
            snapshot_taken_at=offer.snapshot_taken_at or now,
            reliability=reliability_block(offer),
            score=breakdown,
            exclusion_reason=exclusion_reason,
            items_covered=offer.items_covered,
            items_requested=max(offer.items_requested, 1),
        )

    def _fallback_justification(
        self, winner: QuoteRead | None, context: ScoringContext
    ) -> str:
        """Deterministic sentence used when the LLM narrator is unavailable.

        The Claude justification call replaces this with richer prose, but the
        non-negotiable "every decision carries a justification" holds even if
        that call fails.
        """
        if winner is None:
            return (
                "No supplier met the budget constraint. Flagged for human review."
            )
        parts = [f"Selected {winner.vendor_name}"]
        if winner.total_amount is not None:
            parts.append(f"lowest qualifying total {context.currency} {winner.total_amount:,.0f}")
        if winner.delivery_days is not None:
            parts.append(f"{winner.delivery_days}-day delivery")
        if winner.warranty_months is not None:
            years = winner.warranty_months / 12
            label = (
                f"{int(years)}-year warranty"
                if years.is_integer()
                else f"{winner.warranty_months}-month warranty"
            )
            parts.append(label)
        return f"{parts[0]} — " + ", ".join(parts[1:]) + "."

    def _caveats(
        self, winner: QuoteRead | None, qualifying: list[VendorOffer]
    ) -> list[str]:
        caveats: list[str] = []
        if winner is None:
            return caveats
        for offer in qualifying:
            if offer.vendor_id != winner.vendor_id:
                continue
            if not offer.reliability.has_history:
                caveats.append("New vendor — no fulfilment history")
            for field_name in offer.missing_terms:
                caveats.append(
                    f"{offer.vendor_name} did not specify "
                    f"{field_name.replace('_', ' ')}"
                )
        if winner.score and winner.score.confidence.percent < 100:
            caveats.append(winner.score.confidence.label)
        return caveats
