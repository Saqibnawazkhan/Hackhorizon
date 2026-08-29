"""Purchase orders and the code-based validator.

Design screens: 6a (all checks passed), 6b (failed check + self-correction),
7a (PO preview), 12a (admin full PO detail review).

The validator is deterministic Python -- never an LLM call. It compares the PO
against the *quote snapshot*, which is why supplier consistency can be proven
rather than trusted.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import Field, computed_field

from app.schemas.common import AppModel, Identified
from app.schemas.enums import (
    PODeliveryStatus,
    ValidationCheckType,
    ValidationOutcome,
)


class POLineItemRead(Identified):
    purchase_order_id: UUID
    line_number: int = Field(..., ge=1)
    description: str
    sku: str | None
    quantity: int = Field(..., gt=0)
    unit_price: Decimal = Field(..., ge=0)
    line_total: Decimal = Field(..., ge=0)
    delivery_days: int | None = Field(None, ge=0)
    warranty_months: int | None = Field(None, ge=0)
    # Provenance: the snapshot this line was built from.
    quote_id: UUID | None = None
    catalog_item_id: UUID | None = None


class PurchaseOrderRead(Identified):
    po_number: str = Field(..., description="Human reference, e.g. 'PO-2026-0148'.")
    workflow_id: UUID
    vendor_id: UUID
    vendor_name: str
    quote_id: UUID = Field(
        ..., description="The snapshot this PO was built from. Never a live catalog row."
    )

    subtotal: Decimal = Field(..., ge=0)
    tax: Decimal = Field(Decimal("0"), ge=0)
    total_amount: Decimal = Field(..., ge=0)
    currency: str

    delivery_days: int | None = Field(None, ge=0)
    expected_delivery_date: date | None = None
    warranty_months: int | None = Field(None, ge=0)
    payment_terms: str | None = None
    delivery_address: str | None = None
    notes: str | None = None

    delivery_status: PODeliveryStatus
    delivered_at: datetime | None = None
    quantity_delivered: int | None = Field(None, ge=0)

    pdf_path: str | None = Field(
        None, description="Supabase Storage object path. Never a local disk path."
    )
    generation_attempt: int = Field(1, ge=1)

    line_items: list[POLineItemRead] = Field(default_factory=list)
    created_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_units(self) -> int:
        return sum(li.quantity for li in self.line_items)


class PurchaseOrderWithUrl(PurchaseOrderRead):
    """PO plus a short-lived signed URL for the PDF."""

    pdf_url: str | None = None
    pdf_url_expires_at: datetime | None = None


# --------------------------------------------------------------------------
# Validation -- screens 6a / 6b
# --------------------------------------------------------------------------
class ValidationCheck(AppModel):
    """One deterministic check with its expected/actual pair.

    Showing both is what makes the failure state on 6b self-explanatory and
    gives the self-correction loop something concrete to repair.
    """

    check: ValidationCheckType
    title: str = Field(..., description="e.g. 'Budget compliance'.")
    outcome: ValidationOutcome
    expected: str | None = None
    actual: str | None = None
    message: str = Field(..., description="Plain-language result line.")

    @computed_field  # type: ignore[prop-decorator]
    @property
    def passed(self) -> bool:
        return self.outcome is ValidationOutcome.PASSED


class ValidationReport(AppModel):
    workflow_id: UUID
    purchase_order_id: UUID | None
    checks: list[ValidationCheck]
    attempt: int = Field(
        ..., ge=1, description="Which generate_po pass produced the PO under test."
    )
    max_attempts: int = Field(..., ge=1)
    validated_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def passed(self) -> bool:
        return all(
            c.outcome is not ValidationOutcome.FAILED for c in self.checks
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def failed_checks(self) -> list[ValidationCheck]:
        return [c for c in self.checks if c.outcome is ValidationOutcome.FAILED]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def passed_count(self) -> int:
        return sum(1 for c in self.checks if c.passed)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def summary_label(self) -> str:
        """'4 of 4 checks passed' / '3 of 4 checks passed'."""
        return f"{self.passed_count} of {len(self.checks)} checks passed"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def can_self_correct(self) -> bool:
        return not self.passed and self.attempt < self.max_attempts

    @computed_field  # type: ignore[prop-decorator]
    @property
    def must_escalate(self) -> bool:
        """Exhausted the backward edge -- hand to a human (design 6b)."""
        return not self.passed and self.attempt >= self.max_attempts


class DeliveryStatusUpdate(AppModel):
    """Vendor-side update. Feeds reliability scoring."""

    delivery_status: PODeliveryStatus
    quantity_delivered: int | None = Field(None, ge=0)
    delivered_at: datetime | None = None
    note: str | None = Field(None, max_length=500)
