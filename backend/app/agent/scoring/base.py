"""Scoring strategy interface and its input DTOs.

MODE A (single item) and MODE B (multi item) are two implementations of
``ScoringStrategy`` -- not two branches of one function. Adding a third
strategy (policy compliance, framework-agreement pricing, ...) means writing
one class and registering it; nothing in the orchestrator changes.

The engine is PLAIN PYTHON. An LLM never decides a score. A separate Claude
call narrates the result afterwards, and it receives only the numbers this
module produced.

Inputs are plain DTOs, deliberately decoupled from the ORM, so strategies can
be unit-tested with literals and reused by any future caller.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from app.schemas.admin import ScoringWeights
from app.schemas.enums import ScoringStrategyName
from app.schemas.quote import ComparisonBase


@dataclass(frozen=True, slots=True)
class OfferLine:
    """One vendor's offer for one requested line item.

    ``unit_price``/``delivery_days``/``warranty_months`` are snapshots already
    frozen onto the quote row. Nothing here reads a live catalog value.
    """

    request_item_name: str
    quantity: int
    available: bool
    catalog_item_id: UUID | None = None
    sku: str | None = None
    matched_title: str | None = None
    unit_price: Decimal | None = None
    delivery_days: int | None = None
    warranty_months: int | None = None
    stock_on_hand: int | None = None

    @property
    def line_total(self) -> Decimal | None:
        if not self.available or self.unit_price is None:
            return None
        return (self.unit_price * self.quantity).quantize(Decimal("0.01"))


@dataclass(frozen=True, slots=True)
class VendorReliability:
    """Real fulfilment history. Never fabricated."""

    has_history: bool = False
    orders_fulfilled: int = 0
    on_time_rate: float | None = None
    quantity_accuracy: float | None = None
    cancellations: int = 0
    late_deliveries: int = 0

    @property
    def star_score(self) -> float | None:
        """0-5 equivalent, or None when there is no history to compute from."""
        if not self.has_history:
            return None
        on_time = self.on_time_rate if self.on_time_rate is not None else 0.0
        accuracy = (
            self.quantity_accuracy if self.quantity_accuracy is not None else 0.0
        )
        base = (on_time * 0.6) + (accuracy * 0.4)
        penalty = min(self.cancellations * 0.05, 0.25)
        return round(max(0.0, min(1.0, base - penalty)) * 5.0, 1)

    @property
    def display(self) -> str:
        star = self.star_score
        return "No history yet" if star is None else f"{star:.1f}"


@dataclass(frozen=True, slots=True)
class VendorOffer:
    """Everything one vendor brings to the comparison."""

    vendor_id: UUID
    vendor_name: str
    lines: list[OfferLine]
    reliability: VendorReliability = field(default_factory=VendorReliability)
    snapshot_taken_at: datetime | None = None

    # -- coverage ------------------------------------------------------
    @property
    def covered_lines(self) -> list[OfferLine]:
        return [ln for ln in self.lines if ln.available and ln.unit_price is not None]

    @property
    def missing_line_names(self) -> list[str]:
        return [ln.request_item_name for ln in self.lines if not ln.available]

    @property
    def items_covered(self) -> int:
        return len(self.covered_lines)

    @property
    def items_requested(self) -> int:
        return len(self.lines)

    @property
    def covers_all(self) -> bool:
        return self.items_covered == self.items_requested and self.items_requested > 0

    # -- aggregates over covered lines only ----------------------------
    @property
    def total_amount(self) -> Decimal | None:
        totals = [ln.line_total for ln in self.covered_lines]
        if not totals:
            return None
        return sum(totals, Decimal("0"))

    @property
    def delivery_days(self) -> int | None:
        """Slowest covered line -- the order is not complete until all arrive."""
        values = [
            ln.delivery_days
            for ln in self.covered_lines
            if ln.delivery_days is not None
        ]
        return max(values) if values else None

    @property
    def warranty_months(self) -> int | None:
        """Weakest covered line -- the buyer is exposed to the shortest cover."""
        values = [
            ln.warranty_months
            for ln in self.covered_lines
            if ln.warranty_months is not None
        ]
        return min(values) if values else None

    @property
    def missing_terms(self) -> list[str]:
        """Which criteria the vendor left unspecified across covered lines."""
        missing: list[str] = []
        if self.delivery_days is None:
            missing.append("delivery_days")
        if self.warranty_months is None:
            missing.append("warranty_months")
        return missing


@dataclass(slots=True)
class ScoringContext:
    """Everything a strategy needs. No database handle, by design."""

    workflow_id: UUID
    offers: list[VendorOffer]
    weights: ScoringWeights
    currency: str
    budget: Decimal | None = None
    line_item_quantities: dict[str, int] = field(default_factory=dict)
    computed_at: datetime | None = None

    @property
    def item_names(self) -> list[str]:
        for offer in self.offers:
            if offer.lines:
                return [ln.request_item_name for ln in offer.lines]
        return []

    @property
    def is_multi_item(self) -> bool:
        return len(self.item_names) > 1


class ScoringStrategy(ABC):
    """Common interface. Both modes return a ``ComparisonBase`` subclass."""

    name: ScoringStrategyName

    @abstractmethod
    def supports(self, context: ScoringContext) -> bool:
        """Whether this strategy can handle the given request shape."""

    @abstractmethod
    def score(self, context: ScoringContext) -> ComparisonBase:
        """Rank the offers and pick a winner. Pure function of the context."""

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{type(self).__name__} name={self.name.value!r}>"
