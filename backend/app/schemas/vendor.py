"""Vendors, catalog items and vendor-performance flags.

Design screens: 13a (employee adds/views vendors), 15a (catalog browse),
14a/14d (vendor portal price + stock), 14b (add item), 14c (published),
18a (admin vendor management with agent flags).
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import Field, computed_field, model_validator

from app.core.config import settings
from app.schemas.common import AppModel, Identified
from app.schemas.enums import (
    CatalogSourceKind,
    VendorFlagReason,
    VendorStatus,
)
from app.schemas.quote import ReliabilityBlock


# --------------------------------------------------------------------------
# Vendors
# --------------------------------------------------------------------------
class VendorFlag(AppModel):
    """Raised by the background monitoring job -- surfaced on 18a."""

    reason: VendorFlagReason
    detail: str = Field(..., description="e.g. '2 late deliveries · flagged by agent'.")
    raised_at: datetime
    threshold: str = Field(..., description="The configured threshold that was breached.")
    resolved_at: datetime | None = None


class VendorRead(Identified):
    name: str
    legal_name: str | None = None
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    category: str | None = None
    status: VendorStatus
    verified_at: datetime | None = None
    created_by: UUID | None = Field(
        None, description="Employee who added it (13a); null for self-registered."
    )
    user_id: UUID | None = Field(
        None, description="Owning vendor-role user, once the portal account exists."
    )

    # Profile defaults that new catalog items inherit and may override (14b).
    default_delivery_days: int | None = Field(None, ge=0)
    default_warranty_months: int | None = Field(None, ge=0)

    reliability: ReliabilityBlock
    flags: list[VendorFlag] = Field(default_factory=list)
    catalog_item_count: int = Field(0, ge=0)
    last_published_at: datetime | None = None
    created_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_flagged(self) -> bool:
        return any(f.resolved_at is None for f in self.flags)


class VendorCreate(AppModel):
    """Employee-submitted. Always lands as PENDING -- admin verifies (13a)."""

    name: str = Field(..., min_length=2, max_length=200)
    legal_name: str | None = Field(None, max_length=200)
    email: str | None = Field(None, max_length=200)
    phone: str | None = Field(None, max_length=40)
    address: str | None = Field(None, max_length=500)
    category: str | None = Field(None, max_length=100)
    default_delivery_days: int | None = Field(None, ge=0)
    default_warranty_months: int | None = Field(None, ge=0)


class VendorUpdate(AppModel):
    name: str | None = Field(None, min_length=2, max_length=200)
    legal_name: str | None = None
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    category: str | None = None
    default_delivery_days: int | None = Field(None, ge=0)
    default_warranty_months: int | None = Field(None, ge=0)


class VendorStatusUpdate(AppModel):
    """Admin verify / suspend / reinstate (18a)."""

    status: VendorStatus
    reason: str | None = Field(None, max_length=500)


# --------------------------------------------------------------------------
# Catalog items
# --------------------------------------------------------------------------
class CatalogItemBase(AppModel):
    sku: str = Field(..., min_length=1, max_length=64)
    title: str = Field(..., min_length=1, max_length=200)
    description: str | None = Field(None, max_length=1000)
    category: str | None = Field(None, max_length=100)
    brand: str | None = Field(None, max_length=100)
    price: Decimal = Field(..., ge=0)
    sale_price: Decimal | None = Field(None, ge=0)
    currency: str = Field(
        default_factory=lambda: settings.default_currency, min_length=3, max_length=3
    )
    stock: int = Field(..., ge=0)
    # Required on the extended add-item form (14b), inheritable from the
    # vendor profile defaults. Nullable in the DB because CSV imports may
    # legitimately arrive without them -- the vendor is then prompted to fill
    # them in, and the scorer marks affected quotes with reduced confidence.
    delivery_days: int | None = Field(None, ge=0)
    warranty_months: int | None = Field(None, ge=0)
    visible: bool = True

    @model_validator(mode="after")
    def _sale_price_below_price(self) -> CatalogItemBase:
        if self.sale_price is not None and self.sale_price > self.price:
            raise ValueError("sale_price must not exceed price")
        return self


class CatalogItemCreate(CatalogItemBase):
    """Fields left null inherit the vendor profile default at write time."""


class CatalogItemUpdate(AppModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = None
    category: str | None = None
    brand: str | None = None
    price: Decimal | None = Field(None, ge=0)
    sale_price: Decimal | None = Field(None, ge=0)
    stock: int | None = Field(None, ge=0)
    delivery_days: int | None = Field(None, ge=0)
    warranty_months: int | None = Field(None, ge=0)
    visible: bool | None = None


class CatalogItemRead(CatalogItemBase, Identified):
    vendor_id: UUID
    vendor_name: str | None = None
    source: CatalogSourceKind
    published_at: datetime | None = None
    has_unpublished_changes: bool = False
    created_at: datetime
    updated_at: datetime | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def effective_price(self) -> Decimal:
        return self.sale_price if self.sale_price is not None else self.price

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_low_stock(self) -> bool:
        return self.stock <= settings.vendor.low_stock_threshold

    @computed_field  # type: ignore[prop-decorator]
    @property
    def missing_terms(self) -> list[str]:
        """Drives the 'fill in missing delivery/warranty' prompt after import."""
        missing = []
        if self.delivery_days is None:
            missing.append("delivery_days")
        if self.warranty_months is None:
            missing.append("warranty_months")
        return missing


class CatalogDraftState(AppModel):
    """Draft/publish model for the vendor portal (14a)."""

    vendor_id: UUID
    unsaved_change_count: int = Field(..., ge=0)
    last_published_at: datetime | None
    items_missing_terms: int = Field(0, ge=0)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def status_line(self) -> str:
        """'Last published: today, 08:15 AM · 2 unsaved changes' (design 14a)."""
        published = (
            self.last_published_at.strftime("%d %b, %I:%M %p")
            if self.last_published_at
            else "never"
        )
        plural = "" if self.unsaved_change_count == 1 else "s"
        return (
            f"Last published: {published} · "
            f"{self.unsaved_change_count} unsaved change{plural}"
        )


class CatalogPublishRequest(AppModel):
    item_ids: list[UUID] | None = Field(
        None, description="None publishes every dirty item for the vendor."
    )


class CatalogPublishResult(AppModel):
    published_count: int
    published_at: datetime
    skipped_missing_terms: list[UUID] = Field(default_factory=list)
