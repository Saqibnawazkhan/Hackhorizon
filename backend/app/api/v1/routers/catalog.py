"""Catalog endpoints.

Vendor portal (14a/14b/14c): price and stock editing, draft/publish, CSV
import, dummy API connections.
Buyer browse (15a): published, visible items from verified vendors only.

Every vendor-scoped query filters by the vendor profile derived from the
authenticated identity -- never from a client-supplied vendor_id. That, plus
the RLS policies, is what stops a vendor reading a competitor's pricing.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import (
    BuyerDep,
    PaginationDep,
    SessionDep,
    VendorIdDep,
)
from app.core.config import settings
from app.repositories.catalog_repo import CatalogRepository, VendorRepository
from app.schemas.imports import CatalogConnectionCreate
from app.schemas.vendor import (
    CatalogItemCreate,
    CatalogItemUpdate,
    CatalogPublishRequest,
)

router = APIRouter(prefix="/catalog", tags=["catalog"])


def _serialize(item, vendor_name: str | None = None) -> dict[str, Any]:
    missing = []
    if item.delivery_days is None:
        missing.append("delivery_days")
    if item.warranty_months is None:
        missing.append("warranty_months")
    effective = item.sale_price if item.sale_price is not None else item.price
    return {
        "id": str(item.id),
        "vendor_id": str(item.vendor_id),
        "vendor_name": vendor_name,
        "sku": item.sku,
        "title": item.title,
        "description": item.description,
        "category": item.category,
        "brand": item.brand,
        "price": float(item.price),
        "sale_price": float(item.sale_price) if item.sale_price else None,
        "effective_price": float(effective),
        "currency": item.currency,
        "stock": item.stock,
        "is_low_stock": item.stock <= settings.vendor.low_stock_threshold,
        "delivery_days": item.delivery_days,
        "warranty_months": item.warranty_months,
        "missing_terms": missing,
        "visible": item.visible,
        "source": item.source,
        "published_at": item.published_at.isoformat() if item.published_at else None,
        "has_unpublished_changes": item.has_unpublished_changes,
        "created_at": item.created_at.isoformat(),
    }


# --------------------------------------------------------------------------
# Vendor portal -- own catalog only
# --------------------------------------------------------------------------
@router.get("/me", summary="My catalog (screen 14a)")
async def my_catalog(
    vendor_id: VendorIdDep, session: SessionDep, page: PaginationDep
) -> dict[str, Any]:
    repo = CatalogRepository(session)
    rows, total = await repo.list_for_vendor(
        vendor_id, limit=page.limit, offset=page.offset
    )
    draft = await repo.draft_state(vendor_id)
    last = draft["last_published_at"]
    return {
        "items": [_serialize(i) for i in rows],
        "total": total,
        "limit": page.limit,
        "offset": page.offset,
        "draft_state": {
            "vendor_id": str(vendor_id),
            "unsaved_change_count": draft["unsaved_change_count"],
            "items_missing_terms": draft["items_missing_terms"],
            "last_published_at": last.isoformat() if last else None,
            "status_line": (
                f"Last published: "
                f"{last.strftime('%d %b, %I:%M %p') if last else 'never'} · "
                f"{draft['unsaved_change_count']} unsaved change"
                f"{'' if draft['unsaved_change_count'] == 1 else 's'}"
            ),
        },
    }


@router.post(
    "/me/items", status_code=status.HTTP_201_CREATED, summary="Add an item (14b)"
)
async def create_item(
    body: CatalogItemCreate, vendor_id: VendorIdDep, session: SessionDep
) -> dict[str, Any]:
    """New items inherit the vendor profile defaults and may override them."""
    repo = CatalogRepository(session)
    vendors = VendorRepository(session)

    if await repo.get_by_sku(vendor_id, body.sku):
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"SKU {body.sku} already exists in your catalog"
        )

    vendor = await vendors.get_or_raise(vendor_id)
    item = await repo.create(vendor_id=vendor_id, **body.model_dump())
    await repo.apply_vendor_defaults(vendor, item)
    await session.flush()
    return _serialize(item)


@router.patch("/me/items/{item_id}", summary="Edit price / stock / terms (14a)")
async def update_item(
    item_id: UUID,
    body: CatalogItemUpdate,
    vendor_id: VendorIdDep,
    session: SessionDep,
) -> dict[str, Any]:
    repo = CatalogRepository(session)
    item = await repo.get(item_id)
    if item is None or item.vendor_id != vendor_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "item not found")

    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(item, key, value)
    item.has_unpublished_changes = True
    await session.flush()
    return _serialize(item)


@router.delete("/me/items/{item_id}", summary="Remove an item")
async def delete_item(
    item_id: UUID, vendor_id: VendorIdDep, session: SessionDep
) -> dict[str, Any]:
    repo = CatalogRepository(session)
    item = await repo.get(item_id)
    if item is None or item.vendor_id != vendor_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "item not found")
    await repo.delete(item_id)
    return {"deleted": True, "id": str(item_id)}


@router.post("/me/publish", summary="Publish draft changes (14a -> 14c)")
async def publish(
    body: CatalogPublishRequest, vendor_id: VendorIdDep, session: SessionDep
) -> dict[str, Any]:
    """Publishing is what makes items visible to buyers and to the agent."""
    repo = CatalogRepository(session)
    count, at = await repo.publish(vendor_id, body.item_ids)

    vendors = VendorRepository(session)
    vendor = await vendors.get(vendor_id)
    if vendor is not None:
        vendor.last_published_at = at
        await session.flush()

    return {
        "published_count": count,
        "published_at": at.isoformat(),
        "skipped_missing_terms": [],
    }


# --------------------------------------------------------------------------
# Dummy catalog API connections
# --------------------------------------------------------------------------
@router.get("/me/connections", summary="Catalog API connections")
async def list_connections(
    vendor_id: VendorIdDep, session: SessionDep
) -> list[dict[str, Any]]:
    from sqlalchemy import select

    from app.db.models import CatalogConnection

    rows = (
        await session.scalars(
            select(CatalogConnection).where(CatalogConnection.vendor_id == vendor_id)
        )
    ).all()
    return [
        {
            "id": str(c.id),
            "provider": c.provider,
            "label": c.label,
            "store_url": c.store_url,
            "status": c.status,
            "auto_sync_enabled": c.auto_sync_enabled,
            "sync_interval_minutes": c.sync_interval_minutes,
            "last_sync_at": c.last_sync_at.isoformat() if c.last_sync_at else None,
            "last_sync_item_count": c.last_sync_item_count,
            "last_error": c.last_error,
            # Credentials are never returned, only whether they exist.
            "credentials_set": bool(c.credentials_ref),
            "created_at": c.created_at.isoformat(),
        }
        for c in rows
    ]


@router.post(
    "/me/connections",
    status_code=status.HTTP_201_CREATED,
    summary="Connect a catalog source (dummy)",
)
async def create_connection(
    body: CatalogConnectionCreate, vendor_id: VendorIdDep, session: SessionDep
) -> dict[str, Any]:
    """Registers a connection behind the CatalogSource adapter interface.

    No real outbound call is made. A production adapter drops in later without
    touching this endpoint or the agent, which never syncs anything itself.
    """
    from app.db.models import CatalogConnection

    conn = CatalogConnection(
        vendor_id=vendor_id,
        provider=body.provider.value,
        label=body.label,
        store_url=body.store_url,
        credentials_ref=f"vault://{vendor_id}/{body.provider.value}"
        if body.api_key
        else None,
        status="connected",
        auto_sync_enabled=body.auto_sync_enabled,
        sync_interval_minutes=body.sync_interval_minutes,
    )
    session.add(conn)
    await session.flush()
    return {
        "id": str(conn.id),
        "provider": conn.provider,
        "label": conn.label,
        "status": conn.status,
        "credentials_set": bool(conn.credentials_ref),
        "is_simulated": True,
    }


@router.post("/me/connections/{connection_id}/sync", summary="Sync Now (dummy)")
async def sync_connection(
    connection_id: UUID, vendor_id: VendorIdDep, session: SessionDep
) -> dict[str, Any]:
    """Runs the seeded fake adapter. Never reached from the agent path."""
    from app.services.catalog_sources import sync_now

    return await sync_now(session, vendor_id=vendor_id, connection_id=connection_id)


@router.delete("/me/connections/{connection_id}", summary="Disconnect")
async def delete_connection(
    connection_id: UUID, vendor_id: VendorIdDep, session: SessionDep
) -> dict[str, Any]:
    from app.db.models import CatalogConnection

    conn = await session.get(CatalogConnection, connection_id)
    if conn is None or conn.vendor_id != vendor_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "connection not found")
    await session.delete(conn)
    return {"deleted": True, "id": str(connection_id)}


# --------------------------------------------------------------------------
# Buyer browse -- published items only
# --------------------------------------------------------------------------
@router.get("/browse", summary="Browse vendor catalogs (screen 15a)")
async def browse(
    user: BuyerDep,
    session: SessionDep,
    page: PaginationDep,
    vendor_id: UUID | None = Query(None),
    search: str | None = Query(None, max_length=200),
) -> dict[str, Any]:
    from sqlalchemy import or_, select

    from app.db.models import CatalogItem, Vendor

    stmt = (
        select(CatalogItem, Vendor.name)
        .join(Vendor, Vendor.id == CatalogItem.vendor_id)
        .where(
            CatalogItem.visible.is_(True),
            CatalogItem.published_at.is_not(None),
            Vendor.status.in_(["verified", "flagged"]),
        )
    )
    if user.org_id:
        stmt = stmt.where(Vendor.org_id == user.org_id)
    if vendor_id:
        stmt = stmt.where(CatalogItem.vendor_id == vendor_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(
            or_(
                CatalogItem.title.ilike(like),
                CatalogItem.description.ilike(like),
                CatalogItem.brand.ilike(like),
            )
        )

    rows = (
        await session.execute(
            stmt.order_by(CatalogItem.title).offset(page.offset).limit(page.limit)
        )
    ).all()
    return {
        "items": [_serialize(item, vendor_name) for item, vendor_name in rows],
        "limit": page.limit,
        "offset": page.offset,
    }
