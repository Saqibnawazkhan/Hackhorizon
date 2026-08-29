"""Request-for-quotation contracts.

The path out of the dead end. When ``budget_filter`` finds no qualifying
vendor the workflow escalates, and until now that was terminal: the catalog
held no answer and there was no way to ask for one.

A quote request is the ask. The buyer invites vendors, each replies with a
price per line, and the reply is written into that vendor's catalog so the
ordinary ``catalog_query`` path picks it up when the workflow is re-run.

THE AGENT IS NOT INVOLVED. It still only ever reads the catalog, which is what
keeps a run fast, deterministic and replayable. The vendor writes on its own
schedule, exactly as the vendor portal already does.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import Field, computed_field, field_serializer, model_validator

from app.schemas.common import AppModel
from app.schemas.enums import QuoteRequestStatus, QuoteResponseStatus


# --------------------------------------------------------------------------
# Requests
# --------------------------------------------------------------------------
class QuoteRequestCreate(AppModel):
    """Buyer asks vendors to quote on an escalated workflow."""

    vendor_ids: list[UUID] | None = Field(
        None,
        description=(
            "Vendors to invite. Omit to invite every verified vendor in the "
            "organisation, which is the usual case -- the buyer is asking "
            "precisely because they do not know who can supply this."
        ),
    )
    note: str | None = Field(
        None,
        max_length=1000,
        description="Anything the buyer wants to add for the vendors.",
    )
    respond_within_hours: int = Field(
        48,
        ge=1,
        le=720,
        description=(
            "Deadline for replies. Without one an escalated workflow parks "
            "forever waiting on a vendor who is never coming."
        ),
    )


class QuoteResponseLine(AppModel):
    """One line of a vendor's answer."""

    request_item_name: str = Field(
        ..., min_length=1, max_length=200,
        description="Echoes the requested item, so lines can be matched up.",
    )
    available: bool = Field(
        True, description="False means this vendor cannot supply this line."
    )
    sku: str | None = Field(None, max_length=64)
    title: str | None = Field(
        None, max_length=200, description="What the vendor actually sells."
    )
    unit_price: Decimal | None = Field(None, ge=0)
    quantity: int | None = Field(
        None, gt=0, description="Units the vendor can supply, if fewer than asked."
    )
    delivery_days: int | None = Field(None, ge=0)
    warranty_months: int | None = Field(None, ge=0)

    @model_validator(mode="after")
    def _priced_when_available(self) -> QuoteResponseLine:
        if self.available and self.unit_price is None:
            raise ValueError(
                "unit_price is required for a line marked available; mark the "
                "line unavailable instead of quoting it without a price"
            )
        if self.available and not (self.sku and self.title):
            raise ValueError(
                "sku and title are required for a line marked available -- "
                "they become the catalog row the agent reads"
            )
        return self

    @field_serializer("unit_price")
    def _ser_price(self, v: Decimal | None) -> float | None:
        return None if v is None else float(v)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def line_total(self) -> float | None:
        if self.unit_price is None or self.quantity is None:
            return None
        return float(self.unit_price * self.quantity)


class QuoteResponseSubmit(AppModel):
    """A vendor's answer to a quote request."""

    lines: list[QuoteResponseLine] = Field(..., min_length=1)
    note: str | None = Field(None, max_length=1000)
    delivery_days: int | None = Field(
        None, ge=0, description="Overall lead time; defaults to the slowest line."
    )
    warranty_months: int | None = Field(None, ge=0)
    publish_to_catalog: bool = Field(
        True,
        description=(
            "Write these prices into my catalog. This is what makes the offer "
            "visible to the agent -- an answer that is not published cannot be "
            "quoted against, because the agent reads the catalog and nothing "
            "else. Turning it off records the reply for the buyer to read by "
            "hand."
        ),
    )

    @model_validator(mode="after")
    def _at_least_one_available(self) -> QuoteResponseSubmit:
        if not any(line.available for line in self.lines):
            raise ValueError(
                "no line is marked available; decline the request instead"
            )
        return self


class QuoteResponseDecline(AppModel):
    reason: str | None = Field(None, max_length=500)


# --------------------------------------------------------------------------
# Reads
# --------------------------------------------------------------------------
class QuoteResponseRead(AppModel):
    id: UUID
    vendor_id: UUID
    vendor_name: str | None = None
    status: QuoteResponseStatus
    lines: list[dict] = Field(default_factory=list)
    total_amount: float | None = None
    currency: str | None = None
    delivery_days: int | None = None
    warranty_months: int | None = None
    note: str | None = None
    decline_reason: str | None = None
    published_to_catalog: bool = False
    invited_at: datetime
    responded_at: datetime | None = None


class QuoteRequestRead(AppModel):
    id: UUID
    workflow_id: UUID
    workflow_title: str | None = None
    status: QuoteRequestStatus
    reason: str | None = None
    note: str | None = None
    items: list[dict] = Field(default_factory=list)
    currency: str
    budget: float | None = None
    closes_at: datetime | None = None
    created_at: datetime
    closed_at: datetime | None = None
    responses: list[QuoteResponseRead] = Field(default_factory=list)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def invited_count(self) -> int:
        return len(self.responses)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def responded_count(self) -> int:
        return sum(
            1 for r in self.responses if r.status is QuoteResponseStatus.RESPONDED
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def summary_line(self) -> str:
        """'Asked 4 suppliers · 2 replied · 1 declined' -- silence is data."""
        declined = sum(
            1 for r in self.responses if r.status is QuoteResponseStatus.DECLINED
        )
        parts = [f"Asked {self.invited_count} supplier"
                 f"{'' if self.invited_count == 1 else 's'}"]
        parts.append(f"{self.responded_count} replied")
        if declined:
            parts.append(f"{declined} declined")
        return " · ".join(parts)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_actionable(self) -> bool:
        """True when at least one usable quote is in the catalog.

        Drives the "Re-run with these quotes" affordance: re-running before
        anything is published just reproduces the same escalation.
        """
        return any(
            r.status is QuoteResponseStatus.RESPONDED and r.published_to_catalog
            for r in self.responses
        )


# --------------------------------------------------------------------------
# Purchase-order close-out
# --------------------------------------------------------------------------
class PurchaseOrderClose(AppModel):
    """The BUYER's verdict, recorded against the signed-in user.

    Separate from ``DeliveryStatusUpdate``, which is the SUPPLIER's account of
    the same order. A vendor marking an order delivered and a buyer confirming
    it arrived are different claims.
    """

    outcome: str = Field(
        "completed",
        description="completed | completed_with_issues | cancelled",
    )
    note: str | None = Field(
        None,
        max_length=2000,
        description="Why it closed this way. Required when it did not go cleanly.",
    )
    received_quantity: int | None = Field(
        None, ge=0, description="What was actually counted on receipt."
    )

    @model_validator(mode="after")
    def _explain_a_bad_outcome(self) -> PurchaseOrderClose:
        if self.outcome in {"completed_with_issues", "cancelled"} and not (
            self.note and self.note.strip()
        ):
            raise ValueError(
                f"a note is required when closing an order as {self.outcome}"
            )
        return self
