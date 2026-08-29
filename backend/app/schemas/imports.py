"""CSV/Excel import jobs and catalog API connections.

Both are CatalogSource adapters. The import flow is deliberately multi-step so
the vendor sees a preview and per-row errors before anything is committed:

    upload -> preview (+ column mapping + row validation) -> commit (partial ok)

Catalog API connect is DUMMY functionality: full UI and adapter plumbing, but
``Sync Now`` runs against a seeded fake response. No real outbound call is
made, and none is made from the agent execution path either.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import Field, computed_field

from app.schemas.common import AppModel, Identified
from app.schemas.enums import (
    CatalogProvider,
    ConnectionStatus,
    ImportJobStatus,
)


# --------------------------------------------------------------------------
# Column mapping
# --------------------------------------------------------------------------
class ColumnMapping(AppModel):
    """Maps a spreadsheet header to a catalog field."""

    source_column: str
    target_field: str = Field(
        ..., description="sku | title | price | stock | delivery_days | ..."
    )


class ImportTemplateColumn(AppModel):
    name: str
    required: bool
    example: str
    note: str | None = None


class ImportTemplate(AppModel):
    """Drives the downloadable template and the mapping UI."""

    columns: list[ImportTemplateColumn]
    filename: str = "agentflow-catalog-template.csv"


# --------------------------------------------------------------------------
# Rows
# --------------------------------------------------------------------------
class ImportRowError(AppModel):
    field: str
    message: str


class ImportRow(AppModel):
    """One parsed spreadsheet row with its validation verdict."""

    row_number: int = Field(..., ge=1, description="1-based, excluding the header.")
    raw: dict[str, str | None]
    parsed: dict[str, object] | None = None
    errors: list[ImportRowError] = Field(default_factory=list)
    is_duplicate_sku: bool = Field(
        False, description="SKU already exists -- commit updates it in place."
    )
    missing_terms: list[str] = Field(
        default_factory=list,
        description="delivery_days / warranty_months absent; vendor is prompted.",
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_valid(self) -> bool:
        return not self.errors


class ImportPreview(AppModel):
    """Returned by upload; nothing is written to the catalog yet."""

    import_job_id: UUID
    filename: str
    detected_columns: list[str]
    suggested_mapping: list[ColumnMapping]
    rows: list[ImportRow]
    total_rows: int = Field(..., ge=0)
    valid_rows: int = Field(..., ge=0)
    invalid_rows: int = Field(..., ge=0)
    duplicate_rows: int = Field(..., ge=0)
    rows_missing_terms: int = Field(..., ge=0)
    truncated: bool = Field(
        False, description="True when the file exceeded IMPORT_MAX_ROWS."
    )


class ImportCommitRequest(AppModel):
    mapping: list[ColumnMapping] | None = Field(
        None, description="Overrides the suggested mapping when the user edited it."
    )
    commit_valid_only: bool = Field(
        True, description="Partial import: valid rows commit, invalid are flagged."
    )
    update_existing_skus: bool = True
    row_numbers: list[int] | None = Field(
        None, description="Restrict the commit to specific rows."
    )


class ImportJobRead(Identified):
    vendor_id: UUID
    filename: str
    status: ImportJobStatus
    total_rows: int = Field(0, ge=0)
    committed_rows: int = Field(0, ge=0)
    failed_rows: int = Field(0, ge=0)
    created_rows: int = Field(0, ge=0)
    updated_rows: int = Field(0, ge=0)
    rows_missing_terms: int = Field(0, ge=0)
    error: str | None = None
    created_at: datetime
    committed_at: datetime | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def summary_line(self) -> str:
        return (
            f"{self.committed_rows} of {self.total_rows} rows imported"
            f"{f' · {self.failed_rows} skipped' if self.failed_rows else ''}"
        )


class ImportCommitResult(AppModel):
    job: ImportJobRead
    failed_rows: list[ImportRow] = Field(default_factory=list)
    items_needing_terms: list[UUID] = Field(
        default_factory=list,
        description="Prompt the vendor to fill delivery/warranty on these.",
    )


# --------------------------------------------------------------------------
# Catalog API connections (dummy adapter)
# --------------------------------------------------------------------------
class CatalogConnectionCreate(AppModel):
    provider: CatalogProvider
    label: str = Field(..., min_length=1, max_length=140)
    store_url: str | None = Field(None, max_length=300)
    api_key: str | None = Field(
        None, max_length=500, description="Write-only. Never returned by the API."
    )
    api_secret: str | None = Field(None, max_length=500)
    auto_sync_enabled: bool = False
    sync_interval_minutes: int = Field(60, gt=0)


class CatalogConnectionRead(Identified):
    vendor_id: UUID
    provider: CatalogProvider
    label: str
    store_url: str | None
    status: ConnectionStatus
    auto_sync_enabled: bool
    sync_interval_minutes: int
    last_sync_at: datetime | None
    last_sync_item_count: int | None
    last_error: str | None
    credentials_set: bool = Field(
        ..., description="Whether credentials exist. The values are never exposed."
    )
    created_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def status_line(self) -> str:
        if self.last_sync_at is None:
            return "Never synced"
        return f"Last sync: {self.last_sync_at.strftime('%d %b, %I:%M %p')}"


class CatalogSyncResult(AppModel):
    """Result of ``Sync Now``. Runs against a seeded fake response.

    This is a vendor-side operation. It is never invoked from the agent
    execution path -- the agent only ever reads catalog rows from our database.
    """

    connection_id: UUID
    status: ConnectionStatus
    items_fetched: int = Field(..., ge=0)
    items_created: int = Field(..., ge=0)
    items_updated: int = Field(..., ge=0)
    items_skipped: int = Field(..., ge=0)
    synced_at: datetime
    is_simulated: bool = Field(
        True, description="Always true until a real provider adapter is registered."
    )
    message: str


class VendorPricePreview(AppModel):
    """Lightweight row for the portal price/stock editor (14a)."""

    id: UUID
    title: str
    subtitle: str | None
    price: Decimal
    stock: int
    is_low_stock: bool
    is_dirty: bool
