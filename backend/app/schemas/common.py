"""Shared schema primitives: base model, money, pagination, error envelope."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Generic, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_serializer

from app.core.config import settings


class AppModel(BaseModel):
    """Base for every schema in the API.

    Wire format is snake_case -- the Flutter client mirrors it exactly, so no
    aliasing layer is needed on either side. ``from_attributes`` lets routers
    return ORM rows directly through the repository layer.
    """

    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        str_strip_whitespace=True,
        use_enum_values=False,
        ser_json_timedelta="float",
    )


class Money(AppModel):
    """An amount plus its currency. Currency is never assumed."""

    amount: Decimal = Field(..., ge=0, description="Absolute amount, 2dp.")
    currency: str = Field(
        default_factory=lambda: settings.default_currency,
        min_length=3,
        max_length=3,
    )

    @field_serializer("amount")
    def _ser_amount(self, v: Decimal) -> float:
        return float(v)

    @property
    def display(self) -> str:
        return f"{self.currency} {self.amount:,.0f}"


T = TypeVar("T")


class Page(AppModel, Generic[T]):
    """Cursor-less offset pagination -- matches the history screen filters."""

    items: list[T]
    total: int = Field(..., ge=0)
    limit: int = Field(..., gt=0)
    offset: int = Field(..., ge=0)

    @property
    def has_more(self) -> bool:
        return self.offset + len(self.items) < self.total


class ErrorDetail(AppModel):
    field: str | None = None
    message: str


class ErrorEnvelope(AppModel):
    """Every non-2xx response body in the API has this shape."""

    error: str = Field(..., description="Stable machine-readable code.")
    message: str = Field(..., description="Human-readable, safe to display.")
    details: list[ErrorDetail] = Field(default_factory=list)
    request_id: str | None = None
    trace: dict[str, Any] | None = Field(
        default=None,
        description="Populated only when DEBUG is on; never in production.",
    )


class Timestamped(AppModel):
    created_at: datetime
    updated_at: datetime | None = None


class Identified(AppModel):
    id: UUID
