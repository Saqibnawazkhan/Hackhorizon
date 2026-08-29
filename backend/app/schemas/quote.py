"""Quotes and supplier comparison.

Covers both design screens:
  5a  single-item comparison  -> ``SingleItemComparison``
  11a multi-item mixed order  -> ``MultiItemComparison``

Both derive from ``ComparisonBase`` so MODE B is *additive* over MODE A rather
than a fork: shared fields (weights, justification, excluded vendors) live in
the base and are rendered by the same Flutter widgets.

PRICE SNAPSHOT INTEGRITY: every price/delivery/warranty value on a quote is a
snapshot taken at quote time. The PO references the quote, never the live
catalog row, so a vendor republishing mid-workflow cannot corrupt an in-flight
purchase order.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import Field, computed_field

from app.schemas.common import AppModel, Identified
from app.schemas.enums import QuoteStatus, ScoringStrategyName


class ReliabilityBlock(AppModel):
    """Computed from real PO fulfilment history -- never fabricated.

    A vendor below ``settings.vendor.min_orders_for_reliability`` reports
    ``has_history = False``; the UI shows "No history yet" and the scorer uses
    a neutral sub-score, but the agent MUST surface the caveat so the human
    decides.
    """

    has_history: bool
    orders_fulfilled: int = Field(0, ge=0)
    on_time_rate: float | None = Field(None, ge=0.0, le=1.0)
    quantity_accuracy: float | None = Field(None, ge=0.0, le=1.0)
    cancellations: int = Field(0, ge=0)
    late_deliveries: int = Field(0, ge=0)
    score: float | None = Field(
        None, ge=0.0, le=5.0, description="0-5 star equivalent shown in 5a/11a."
    )
    display: str = Field(
        ..., description="Ready-to-render label, e.g. '4.8' or 'No history yet'."
    )


class DataConfidence(AppModel):
    """Visible confidence when a vendor omitted optional catalog fields.

    Design copy target:
      "Metro Computers -- score 81, data confidence 67% (warranty not specified)"
    """

    percent: int = Field(..., ge=0, le=100)
    missing_fields: list[str] = Field(default_factory=list)
    scored_on: list[str] = Field(
        ..., description="Criteria that actually contributed to the score."
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def label(self) -> str:
        if not self.missing_fields:
            return f"data confidence {self.percent}%"
        pretty = ", ".join(f.replace("_", " ") for f in self.missing_fields)
        return f"data confidence {self.percent}% ({pretty} not specified)"


class ScoreComponent(AppModel):
    """One weighted criterion. Renders as one segment of the stacked score bar."""

    criterion: str = Field(..., description="price | delivery | warranty | reliability")
    raw_value: float | None = Field(None, description="Pre-normalisation value.")
    normalised: float = Field(..., ge=0.0, le=1.0)
    weight: float = Field(..., ge=0.0, le=1.0)
    was_imputed: bool = Field(
        False, description="True when the vendor omitted this field."
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def contribution(self) -> float:
        """Points out of 100 -- the segment width in the design's score bar."""
        return round(self.normalised * self.weight * 100, 2)


class ScoreBreakdown(AppModel):
    total: float = Field(..., ge=0.0, le=100.0)
    components: list[ScoreComponent]
    confidence: DataConfidence


class QuoteLine(AppModel):
    """Per-item pricing within one vendor quote (11a shows one row per line)."""

    request_item_name: str
    catalog_item_id: UUID | None = Field(
        None, description="None when the vendor does not stock this item."
    )
    sku: str | None = None
    matched_title: str | None = Field(
        None, description="e.g. 'Dell Latitude 5550' -- what the vendor actually sells."
    )
    quantity: int = Field(..., gt=0)
    available: bool = Field(
        ..., description="False renders as 'Not stocked' in the coverage matrix."
    )
    stock_on_hand: int | None = None
    # --- snapshot fields ---
    unit_price: Decimal | None = Field(None, ge=0)
    line_total: Decimal | None = Field(None, ge=0)
    delivery_days: int | None = Field(None, ge=0)
    warranty_months: int | None = Field(None, ge=0)


class QuoteRead(Identified):
    """One vendor's quote for the whole request, with snapshots frozen."""

    workflow_id: UUID
    vendor_id: UUID
    vendor_name: str
    status: QuoteStatus
    lines: list[QuoteLine]

    # --- snapshot aggregates (frozen at quote time) ---
    total_amount: Decimal | None = Field(None, ge=0)
    currency: str
    delivery_days: int | None = Field(None, ge=0)
    warranty_months: int | None = Field(None, ge=0)
    snapshot_taken_at: datetime

    reliability: ReliabilityBlock
    score: ScoreBreakdown | None = Field(
        None, description="None for vendors excluded before scoring."
    )
    exclusion_reason: str | None = Field(
        None, description="e.g. 'Exceeds budget -- excluded' (design 5a/11a)."
    )

    # --- multi-item coverage (MODE B; trivially 1/1 in MODE A) ---
    items_covered: int = Field(..., ge=0)
    items_requested: int = Field(..., gt=0)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def coverage_ratio(self) -> float:
        return round(self.items_covered / self.items_requested, 4)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def coverage_label(self) -> str:
        """'Covers 3/3 items' or 'Covers 2/3 -- no CPUs' (design 11a)."""
        base = f"Covers {self.items_covered}/{self.items_requested} items"
        if self.items_covered == self.items_requested:
            return base
        missing = [ln.request_item_name for ln in self.lines if not ln.available]
        if missing:
            return f"Covers {self.items_covered}/{self.items_requested} — no {', '.join(missing)}"
        return base

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_partial(self) -> bool:
        """Partial totals render with an asterisk in the design."""
        return self.items_covered < self.items_requested


class SplitAllocation(AppModel):
    """One vendor's share of a split-order scenario."""

    vendor_id: UUID
    vendor_name: str
    item_names: list[str]
    subtotal: Decimal = Field(..., ge=0)
    delivery_days: int | None = None


class ScenarioOption(AppModel):
    """A candidate fulfilment plan: one vendor, or a split across several."""

    key: str = Field(..., description="Stable id, e.g. 'single:techsupplies' or 'split:a+b'.")
    label: str
    is_split: bool
    allocations: list[SplitAllocation]
    goods_total: Decimal = Field(..., ge=0)
    po_overhead: Decimal = Field(
        ..., ge=0, description="Charged per PO beyond the first (configurable)."
    )
    effective_total: Decimal = Field(..., ge=0, description="goods_total + po_overhead.")
    lead_time_days: int | None = Field(
        None, description="Slowest allocation -- a split waits for its last delivery."
    )
    covers_all_items: bool
    score: float = Field(..., ge=0.0, le=100.0)
    within_budget: bool
    savings_vs_best_single: Decimal | None = Field(
        None, description="Positive means this scenario is cheaper."
    )
    extra_lead_days_vs_best_single: int | None = None


class ComparisonBase(AppModel):
    """Fields common to MODE A and MODE B, rendered by the same widgets."""

    workflow_id: UUID
    strategy: ScoringStrategyName
    currency: str
    budget: Decimal | None
    weights: dict[str, float] = Field(
        ..., description="Weights actually applied, e.g. {'price': 0.5, ...}."
    )
    weights_label: str = Field(
        ..., description="'Price 50% · Delivery 30% · Warranty 20%' (design 5a)."
    )
    quotes: list[QuoteRead] = Field(..., description="Ranked; excluded vendors last.")
    selected_quote_id: UUID | None
    justification: str = Field(
        ..., description="Plain-language reason for the pick. Never empty."
    )
    caveats: list[str] = Field(default_factory=list)
    computed_at: datetime


class SingleItemComparison(ComparisonBase):
    """MODE A -- design screen 5a."""

    item_name: str
    quantity: int = Field(..., gt=0)


class MultiItemComparison(ComparisonBase):
    """MODE B -- design screen 11a."""

    line_items: list[dict] = Field(
        ..., description="[{name, quantity}] -- renders the chip row on 11a."
    )
    scenarios: list[ScenarioOption] = Field(
        ..., description="Single-vendor and split options, ranked."
    )
    selected_scenario_key: str | None
