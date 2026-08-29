"""MODE B -- multi-item coverage scoring. Design screen 11a.

Extends MODE A rather than forking it: the per-vendor quote objects, the
normalisers, the reliability block and the exclusion copy are all reused. What
MODE B adds is the *scenario* layer.

    coverage   -- how many of the requested line items a vendor can supply
    scenarios  -- candidate fulfilment plans:
                    * single-vendor: one PO, one supplier, full coverage
                    * split:         cheapest supplier per line, several POs
    trade-off  -- a split usually costs less in goods but adds administrative
                  overhead per extra PO and waits for its slowest leg. Both
                  are configurable, so the trade-off is policy, not a constant
                  buried in the code.

A partial-coverage vendor is shown with its partial total (the design marks it
with an asterisk) but can never win as a single-vendor scenario.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from app.core.config import settings
from app.agent.scoring.base import ScoringContext, ScoringStrategy, VendorOffer
from app.agent.scoring.normalizers import (
    build_components,
    build_confidence,
    total_score,
)
from app.agent.scoring.single_item import (
    EXCEEDS_BUDGET,
    NO_PRICE,
    is_within_budget,
    quote_lines,
    reliability_block,
)
from app.schemas.enums import QuoteStatus, ScoringStrategyName
from app.schemas.quote import (
    MultiItemComparison,
    QuoteRead,
    ScenarioOption,
    ScoreBreakdown,
    SplitAllocation,
)

PARTIAL_COVERAGE = "Partial coverage — cannot fulfil the whole order alone"


@dataclass(slots=True)
class _Candidate:
    """A scenario before it has been scored against its peers."""

    key: str
    label: str
    is_split: bool
    allocations: list[SplitAllocation]
    goods_total: Decimal
    po_overhead: Decimal
    lead_time_days: int | None
    warranty_months: int | None
    reliability_star: float | None
    covers_all: bool

    @property
    def effective_total(self) -> Decimal:
        return self.goods_total + self.po_overhead


class MultiItemScoringStrategy(ScoringStrategy):
    """Coverage-aware ranking across single-vendor and split scenarios."""

    name = ScoringStrategyName.MULTI_ITEM

    def supports(self, context: ScoringContext) -> bool:
        return context.is_multi_item

    def score(self, context: ScoringContext) -> MultiItemComparison:
        now = context.computed_at or datetime.now(UTC)
        weights = context.weights.as_dict()
        overhead_unit = Decimal(
            str(settings.scoring.split_order_overhead_per_extra_po)
        )

        quotes = self._build_quotes(context, now, weights)
        candidates = self._build_candidates(context, overhead_unit)
        scenarios = self._score_candidates(candidates, context, weights)

        selected = next(
            (s for s in scenarios if s.within_budget and s.covers_all_items), None
        )
        selected_quote_id = None
        if selected is not None and not selected.is_split:
            vendor_id = selected.allocations[0].vendor_id
            for q in quotes:
                if q.vendor_id == vendor_id:
                    q.status = QuoteStatus.SELECTED
                    selected_quote_id = q.id
                    break

        return MultiItemComparison(
            workflow_id=context.workflow_id,
            strategy=self.name,
            currency=context.currency,
            budget=context.budget,
            weights=weights,
            weights_label=context.weights.label,
            quotes=quotes,
            selected_quote_id=selected_quote_id,
            justification=self._fallback_justification(selected, scenarios, context),
            caveats=self._caveats(selected, context),
            computed_at=now,
            line_items=[
                {"name": name, "quantity": context.line_item_quantities.get(name, 0)}
                for name in context.item_names
            ],
            scenarios=scenarios,
            selected_scenario_key=selected.key if selected else None,
        )

    # -- per-vendor quotes --------------------------------------------
    def _build_quotes(
        self, context: ScoringContext, now: datetime, weights: dict[str, float]
    ) -> list[QuoteRead]:
        eligible = [
            o
            for o in context.offers
            if o.covers_all and is_within_budget(o.total_amount, context.budget)
        ]
        best_total = min(
            (o.total_amount for o in eligible if o.total_amount is not None),
            default=None,
        )
        best_delivery = min(
            (o.delivery_days for o in eligible if o.delivery_days is not None),
            default=None,
        )
        best_warranty = max(
            (o.warranty_months for o in eligible if o.warranty_months is not None),
            default=None,
        )

        quotes: list[QuoteRead] = []
        for offer in context.offers:
            total = offer.total_amount
            status, reason, breakdown = QuoteStatus.QUOTED, None, None

            if total is None:
                status, reason = QuoteStatus.EXCLUDED_STOCK, NO_PRICE
            elif not is_within_budget(total, context.budget):
                status, reason = QuoteStatus.EXCLUDED_BUDGET, EXCEEDS_BUDGET
            elif not offer.covers_all:
                # Shown with its partial total, but never a single-vendor winner.
                status, reason = QuoteStatus.EXCLUDED_COVERAGE, PARTIAL_COVERAGE
            else:
                components = build_components(
                    total_amount=total,
                    delivery_days=offer.delivery_days,
                    warranty_months=offer.warranty_months,
                    reliability_star=offer.reliability.star_score,
                    best_total=best_total,
                    best_delivery=best_delivery,
                    best_warranty=best_warranty,
                    weights=weights,
                )
                breakdown = ScoreBreakdown(
                    total=total_score(components),
                    components=components,
                    confidence=build_confidence(components),
                )

            quotes.append(
                QuoteRead(
                    id=offer.vendor_id,
                    workflow_id=context.workflow_id,
                    vendor_id=offer.vendor_id,
                    vendor_name=offer.vendor_name,
                    status=status,
                    lines=quote_lines(offer),
                    total_amount=total,
                    currency=context.currency,
                    delivery_days=offer.delivery_days,
                    warranty_months=offer.warranty_months,
                    snapshot_taken_at=offer.snapshot_taken_at or now,
                    reliability=reliability_block(offer),
                    score=breakdown,
                    exclusion_reason=reason,
                    items_covered=offer.items_covered,
                    items_requested=max(offer.items_requested, 1),
                )
            )

        quotes.sort(
            key=lambda q: (q.score.total if q.score else -1.0, q.coverage_ratio),
            reverse=True,
        )
        return quotes

    # -- scenarios -----------------------------------------------------
    def _build_candidates(
        self, context: ScoringContext, overhead_unit: Decimal
    ) -> list[_Candidate]:
        candidates: list[_Candidate] = []

        # (a) one scenario per full-coverage vendor
        for offer in context.offers:
            if not offer.covers_all or offer.total_amount is None:
                continue
            candidates.append(
                _Candidate(
                    key=f"single:{offer.vendor_id}",
                    label=f"{offer.vendor_name} — single PO",
                    is_split=False,
                    allocations=[
                        SplitAllocation(
                            vendor_id=offer.vendor_id,
                            vendor_name=offer.vendor_name,
                            item_names=[
                                ln.request_item_name for ln in offer.covered_lines
                            ],
                            subtotal=offer.total_amount,
                            delivery_days=offer.delivery_days,
                        )
                    ],
                    goods_total=offer.total_amount,
                    po_overhead=Decimal("0"),
                    lead_time_days=offer.delivery_days,
                    warranty_months=offer.warranty_months,
                    reliability_star=offer.reliability.star_score,
                    covers_all=True,
                )
            )

        # (b) cheapest-per-line split
        split = self._build_split_candidate(context, overhead_unit)
        if split is not None:
            candidates.append(split)

        return candidates

    def _build_split_candidate(
        self, context: ScoringContext, overhead_unit: Decimal
    ) -> _Candidate | None:
        """Greedy: award each line item to whichever vendor prices it lowest."""
        by_vendor: dict[str, dict] = {}

        for item_name in context.item_names:
            best_offer: VendorOffer | None = None
            best_line = None
            for offer in context.offers:
                for line in offer.covered_lines:
                    if line.request_item_name != item_name:
                        continue
                    if best_line is None or (
                        line.line_total is not None
                        and best_line.line_total is not None
                        and line.line_total < best_line.line_total
                    ):
                        best_offer, best_line = offer, line
            if best_offer is None or best_line is None or best_line.line_total is None:
                return None  # an item nobody stocks -- no split can cover the order

            bucket = by_vendor.setdefault(
                str(best_offer.vendor_id),
                {
                    "offer": best_offer,
                    "items": [],
                    "subtotal": Decimal("0"),
                    "delivery": [],
                    "warranty": [],
                },
            )
            bucket["items"].append(item_name)
            bucket["subtotal"] += best_line.line_total
            if best_line.delivery_days is not None:
                bucket["delivery"].append(best_line.delivery_days)
            if best_line.warranty_months is not None:
                bucket["warranty"].append(best_line.warranty_months)

        if len(by_vendor) < 2:
            return None  # degenerate: identical to a single-vendor scenario

        allocations: list[SplitAllocation] = []
        goods_total = Decimal("0")
        lead_times: list[int] = []
        warranties: list[int] = []
        stars: list[float] = []

        for bucket in by_vendor.values():
            offer: VendorOffer = bucket["offer"]
            delivery = max(bucket["delivery"]) if bucket["delivery"] else None
            allocations.append(
                SplitAllocation(
                    vendor_id=offer.vendor_id,
                    vendor_name=offer.vendor_name,
                    item_names=bucket["items"],
                    subtotal=bucket["subtotal"],
                    delivery_days=delivery,
                )
            )
            goods_total += bucket["subtotal"]
            if delivery is not None:
                lead_times.append(delivery)
            warranties.extend(bucket["warranty"])
            if offer.reliability.star_score is not None:
                stars.append(offer.reliability.star_score)

        return _Candidate(
            key="split:" + "+".join(sorted(a.vendor_name for a in allocations)),
            label=f"Split across {len(allocations)} suppliers",
            is_split=True,
            allocations=allocations,
            goods_total=goods_total,
            po_overhead=overhead_unit * (len(allocations) - 1),
            # A split is only complete when its slowest leg lands.
            lead_time_days=max(lead_times) if lead_times else None,
            warranty_months=min(warranties) if warranties else None,
            reliability_star=(sum(stars) / len(stars)) if stars else None,
            covers_all=True,
        )

    def _score_candidates(
        self,
        candidates: list[_Candidate],
        context: ScoringContext,
        weights: dict[str, float],
    ) -> list[ScenarioOption]:
        if not candidates:
            return []

        best_total = min(c.effective_total for c in candidates)
        lead_times = [c.lead_time_days for c in candidates if c.lead_time_days is not None]
        best_lead = min(lead_times) if lead_times else None
        warranties = [c.warranty_months for c in candidates if c.warranty_months is not None]
        best_warranty = max(warranties) if warranties else None

        singles = [c for c in candidates if not c.is_split]
        best_single_total = min((c.effective_total for c in singles), default=None)
        best_single_lead = min(
            (c.lead_time_days for c in singles if c.lead_time_days is not None),
            default=None,
        )
        penalty_per_day = settings.scoring.split_lead_time_penalty_per_day

        options: list[ScenarioOption] = []
        for c in candidates:
            components = build_components(
                total_amount=c.effective_total,
                delivery_days=c.lead_time_days,
                warranty_months=c.warranty_months,
                reliability_star=c.reliability_star,
                best_total=best_total,
                best_delivery=best_lead,
                best_warranty=best_warranty,
                weights=weights,
            )
            score = total_score(components)

            extra_days = None
            if (
                c.is_split
                and c.lead_time_days is not None
                and best_single_lead is not None
            ):
                extra_days = max(0, c.lead_time_days - best_single_lead)
                score = round(max(0.0, score - extra_days * penalty_per_day), 2)

            savings = (
                best_single_total - c.effective_total
                if (c.is_split and best_single_total is not None)
                else None
            )

            options.append(
                ScenarioOption(
                    key=c.key,
                    label=c.label,
                    is_split=c.is_split,
                    allocations=c.allocations,
                    goods_total=c.goods_total,
                    po_overhead=c.po_overhead,
                    effective_total=c.effective_total,
                    lead_time_days=c.lead_time_days,
                    covers_all_items=c.covers_all,
                    score=score,
                    within_budget=is_within_budget(c.effective_total, context.budget),
                    savings_vs_best_single=savings,
                    extra_lead_days_vs_best_single=extra_days,
                )
            )

        options.sort(key=lambda o: (o.within_budget, o.score), reverse=True)
        return options

    # -- narration -----------------------------------------------------
    def _fallback_justification(
        self,
        selected: ScenarioOption | None,
        scenarios: list[ScenarioOption],
        context: ScoringContext,
    ) -> str:
        if selected is None:
            return (
                "No supplier or combination of suppliers could cover every line "
                "item within budget. Flagged for human review."
            )

        cur = context.currency
        name = selected.allocations[0].vendor_name
        total = f"{cur} {selected.effective_total:,.0f}"

        if selected.is_split:
            names = " and ".join(a.vendor_name for a in selected.allocations)
            return (
                f"Split across {names} — total {total} including "
                f"{cur} {selected.po_overhead:,.0f} of extra purchase-order "
                f"overhead. Cheaper than any single supplier covering all "
                f"{len(context.item_names)} line items."
            )

        parts = [
            f"Selected {name} — only in-budget supplier covering all "
            f"{len(context.item_names)} line items in one PO. Total {total}"
        ]
        if context.budget:
            pct = int(round(float(selected.effective_total) / float(context.budget) * 100))
            parts.append(f" ({pct}% of budget)")
        parts.append(".")

        alt = next((s for s in scenarios if s.is_split), None)
        if alt is not None:
            extra = alt.extra_lead_days_vs_best_single or 0
            parts.append(
                f" Splitting across "
                f"{' and '.join(a.vendor_name for a in alt.allocations)} would add "
                f"{len(alt.allocations) - 1} more purchase order"
                f"{'s' if len(alt.allocations) > 2 else ''}"
                f"{f' and {extra}-day lead time' if extra else ''}."
            )
        return "".join(parts)

    def _caveats(
        self, selected: ScenarioOption | None, context: ScoringContext
    ) -> list[str]:
        caveats: list[str] = []
        if selected is None:
            return caveats
        chosen_ids = {a.vendor_id for a in selected.allocations}
        for offer in context.offers:
            if offer.vendor_id not in chosen_ids:
                continue
            if not offer.reliability.has_history:
                caveats.append(
                    f"{offer.vendor_name}: new vendor — no fulfilment history"
                )
            for field_name in offer.missing_terms:
                caveats.append(
                    f"{offer.vendor_name} did not specify "
                    f"{field_name.replace('_', ' ')}"
                )
        return caveats
