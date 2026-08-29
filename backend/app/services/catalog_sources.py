"""CatalogSource adapters.

Three ways a catalog row can arrive, behind one interface:

    ManualSource   -- the vendor typed it (screen 14b)
    CsvSource      -- the vendor uploaded a spreadsheet
    ApiSyncSource  -- a provider connection pulled it

Only the third would ever touch the network, and in this build it does not:
``SimulatedProviderSource`` returns a seeded fixture so the whole Sync Now
flow is demonstrable end to end. A real Shopify adapter is one new subclass
plus one registration -- no endpoint, engine or agent change.

Whichever adapter writes a row, THE AGENT NEVER CALLS ONE. Sync is a
vendor-side operation on its own schedule, entirely outside the agent
execution path.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.repositories.catalog_repo import CatalogRepository, VendorRepository
from app.schemas.enums import CatalogProvider, CatalogSourceKind

log = structlog.get_logger(__name__)


@dataclass(slots=True)
class SourceItem:
    """One catalog row as an adapter produced it, before validation."""

    sku: str
    title: str
    price: Decimal
    stock: int
    description: str | None = None
    category: str | None = None
    brand: str | None = None
    sale_price: Decimal | None = None
    delivery_days: int | None = None
    warranty_months: int | None = None
    currency: str = field(default_factory=lambda: settings.default_currency)


@dataclass(slots=True)
class SyncOutcome:
    items_fetched: int = 0
    items_created: int = 0
    items_updated: int = 0
    items_skipped: int = 0
    errors: list[str] = field(default_factory=list)


class CatalogSource(ABC):
    """Common interface. Adding a source is one subclass plus one register()."""

    kind: CatalogSourceKind
    is_simulated: bool = False

    @abstractmethod
    async def fetch(self, *, vendor_id: UUID, config: dict[str, Any]) -> list[SourceItem]:
        """Produce catalog rows. May be a network call in a real adapter."""

    async def apply(
        self, session: AsyncSession, *, vendor_id: UUID, items: list[SourceItem]
    ) -> SyncOutcome:
        """Upsert by SKU. Shared by every adapter, so behaviour is identical
        whichever route a row arrived through."""
        repo = CatalogRepository(session)
        vendors = VendorRepository(session)
        vendor = await vendors.get_or_raise(vendor_id)

        outcome = SyncOutcome(items_fetched=len(items))
        for item in items:
            if not item.sku or not item.title:
                outcome.items_skipped += 1
                outcome.errors.append(f"row missing sku or title: {item!r}")
                continue

            row, created = await repo.upsert_by_sku(
                vendor_id,
                item.sku,
                {
                    "title": item.title,
                    "description": item.description,
                    "category": item.category,
                    "brand": item.brand,
                    "price": item.price,
                    "sale_price": item.sale_price,
                    "currency": item.currency,
                    "stock": item.stock,
                    "delivery_days": item.delivery_days,
                    "warranty_months": item.warranty_months,
                    "source": self.kind.value,
                },
            )
            # Items arriving without terms inherit the vendor defaults; if the
            # vendor has none either, the item is flagged so the portal can
            # prompt, and the scorer lowers its data confidence.
            await repo.apply_vendor_defaults(vendor, row)

            if created:
                outcome.items_created += 1
            else:
                outcome.items_updated += 1

        await session.flush()
        return outcome


class ManualSource(CatalogSource):
    """The vendor typed it in. fetch() is never used."""

    kind = CatalogSourceKind.MANUAL

    async def fetch(self, *, vendor_id: UUID, config: dict[str, Any]) -> list[SourceItem]:
        return []


class CsvSource(CatalogSource):
    """Rows parsed from an uploaded spreadsheet."""

    kind = CatalogSourceKind.CSV_IMPORT

    def __init__(self, rows: list[SourceItem] | None = None) -> None:
        self._rows = rows or []

    async def fetch(self, *, vendor_id: UUID, config: dict[str, Any]) -> list[SourceItem]:
        return list(self._rows)


# --------------------------------------------------------------------------
# Simulated provider adapters -- DUMMY functionality, by design
# --------------------------------------------------------------------------
_FIXTURE: dict[CatalogProvider, list[dict[str, Any]]] = {
    CatalogProvider.SHOPIFY: [
        {
            "sku": "SHP-LAT-5550",
            "title": "Dell Latitude 5550 laptop",
            "description": "i7 · 16GB · 512GB",
            "category": "IT hardware",
            "brand": "Dell",
            "price": "174000",
            "stock": 240,
            "delivery_days": 7,
            "warranty_months": 24,
        },
        {
            "sku": "SHP-DOCK-USBC",
            "title": "USB-C docking kit",
            "description": "Dual-4K · 100W PD",
            "category": "Accessories",
            "brand": "Dell",
            "price": "11500",
            "stock": 12,
            "delivery_days": 7,
            "warranty_months": 24,
        },
    ],
    CatalogProvider.WOOCOMMERCE: [
        {
            "sku": "WOO-CPU-13700",
            "title": "Intel i7-13700 CPU kit",
            "description": "16-core · 32GB DDR5",
            "category": "Components",
            "brand": "Intel",
            "price": "96000",
            "stock": 58,
            "delivery_days": 7,
            "warranty_months": 24,
        },
    ],
    CatalogProvider.GENERIC_REST: [
        {
            "sku": "GEN-MON-27",
            "title": "27-inch 4K monitor",
            "description": "IPS · USB-C 90W",
            "category": "Peripherals",
            "brand": "Generic",
            "price": "62000",
            "stock": 40,
            # Deliberately missing delivery/warranty: exercises the
            # data-confidence path and the post-import prompt.
            "delivery_days": None,
            "warranty_months": None,
        },
    ],
}


class SimulatedProviderSource(CatalogSource):
    """Returns a seeded fixture instead of calling the provider.

    The whole connect / status / Sync Now flow is exercised without a real
    integration. Swapping in a live adapter means implementing ``fetch`` and
    registering it under the same provider key.
    """

    kind = CatalogSourceKind.API_SYNC
    is_simulated = True

    def __init__(self, provider: CatalogProvider) -> None:
        self.provider = provider

    async def fetch(self, *, vendor_id: UUID, config: dict[str, Any]) -> list[SourceItem]:
        return [
            SourceItem(
                sku=row["sku"],
                title=row["title"],
                description=row.get("description"),
                category=row.get("category"),
                brand=row.get("brand"),
                price=Decimal(row["price"]),
                stock=int(row["stock"]),
                delivery_days=row.get("delivery_days"),
                warranty_months=row.get("warranty_months"),
            )
            for row in _FIXTURE.get(self.provider, [])
        ]


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------
_PROVIDER_SOURCES: dict[CatalogProvider, type[CatalogSource] | CatalogSource] = {}


def register_provider(provider: CatalogProvider, source: CatalogSource) -> None:
    _PROVIDER_SOURCES[provider] = source


def get_provider_source(provider: CatalogProvider) -> CatalogSource:
    source = _PROVIDER_SOURCES.get(provider)
    if source is None:
        # Default to the simulation so an unregistered provider still demos.
        return SimulatedProviderSource(provider)
    return source


for _provider in CatalogProvider:
    register_provider(_provider, SimulatedProviderSource(_provider))


async def sync_now(
    session: AsyncSession, *, vendor_id: UUID, connection_id: UUID
) -> dict[str, Any]:
    """Run one sync for a vendor connection. Vendor-side only."""
    from fastapi import HTTPException, status

    from app.db.models import CatalogConnection

    conn = await session.get(CatalogConnection, connection_id)
    if conn is None or conn.vendor_id != vendor_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "connection not found")

    provider = CatalogProvider(conn.provider)
    source = get_provider_source(provider)

    conn.status = "syncing"
    await session.flush()

    try:
        items = await source.fetch(vendor_id=vendor_id, config={"url": conn.store_url})
        outcome = await source.apply(session, vendor_id=vendor_id, items=items)
    except Exception as exc:  # noqa: BLE001 - reported on the connection card
        conn.status = "error"
        conn.last_error = f"{type(exc).__name__}: {exc}"
        await session.flush()
        log.warning("catalog_sync.failed", connection=str(connection_id), error=str(exc))
        return {
            "connection_id": str(connection_id),
            "status": conn.status,
            "items_fetched": 0,
            "items_created": 0,
            "items_updated": 0,
            "items_skipped": 0,
            "synced_at": datetime.now(UTC).isoformat(),
            "is_simulated": source.is_simulated,
            "message": conn.last_error,
        }

    conn.status = "connected"
    conn.last_sync_at = datetime.now(UTC)
    conn.last_sync_item_count = outcome.items_fetched
    conn.last_error = None
    await session.flush()

    log.info(
        "catalog_sync.ok",
        connection=str(connection_id),
        provider=provider.value,
        fetched=outcome.items_fetched,
        simulated=source.is_simulated,
    )
    return {
        "connection_id": str(connection_id),
        "status": conn.status,
        "items_fetched": outcome.items_fetched,
        "items_created": outcome.items_created,
        "items_updated": outcome.items_updated,
        "items_skipped": outcome.items_skipped,
        "synced_at": conn.last_sync_at.isoformat(),
        "is_simulated": source.is_simulated,
        "message": (
            f"Synced {outcome.items_fetched} item(s) from "
            f"{provider.value} ({outcome.items_created} new, "
            f"{outcome.items_updated} updated)."
            + (" Simulated response." if source.is_simulated else "")
        ),
    }
