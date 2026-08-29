"""Vendor endpoints.

Buyer side (screens 13a, 18a): browse vendors, add one for admin verification.
Admin side (18a): verify, suspend, reinstate, delete.
Vendor side: own profile and own purchase orders only.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import (
    AdminDep,
    BuyerDep,
    CurrentUserDep,
    PaginationDep,
    SessionDep,
    VendorIdDep,
)
from app.core.config import settings
from app.repositories.catalog_repo import VendorRepository
from app.api.v1.routers.approvals import signed_pdf_url
from app.repositories.procurement_repo import PurchaseOrderRepository
from app.schemas.enums import PODeliveryStatus, UserRole, VendorStatus
from app.schemas.po import DeliveryStatusUpdate
from app.schemas.vendor import VendorCreate, VendorStatusUpdate

router = APIRouter(prefix="/vendors", tags=["vendors"])


def _reliability_display(v) -> dict[str, Any]:
    """Never fabricate a rating -- new vendors say so explicitly."""
    has_history = v.orders_fulfilled >= settings.vendor.min_orders_for_reliability
    return {
        "has_history": has_history,
        "orders_fulfilled": v.orders_fulfilled,
        "on_time_rate": float(v.on_time_rate) if v.on_time_rate is not None else None,
        "quantity_accuracy": (
            float(v.quantity_accuracy) if v.quantity_accuracy is not None else None
        ),
        "cancellations": v.cancellations,
        "late_deliveries": v.late_deliveries,
        "score": float(v.reliability_score) if v.reliability_score else None,
        "display": (
            f"{float(v.reliability_score):.1f}"
            if has_history and v.reliability_score
            else "No history yet"
        ),
    }


def _serialize(v, flags: list | None = None) -> dict[str, Any]:
    return {
        "id": str(v.id),
        "name": v.name,
        "legal_name": v.legal_name,
        "email": v.email,
        "phone": v.phone,
        "address": v.address,
        "category": v.category,
        "status": v.status,
        "verified_at": v.verified_at.isoformat() if v.verified_at else None,
        "default_delivery_days": v.default_delivery_days,
        "default_warranty_months": v.default_warranty_months,
        "last_published_at": (
            v.last_published_at.isoformat() if v.last_published_at else None
        ),
        "created_at": v.created_at.isoformat(),
        "reliability": _reliability_display(v),
        "flags": [
            {
                "reason": f.reason,
                "detail": f.detail,
                "threshold": f.threshold,
                "raised_at": f.raised_at.isoformat(),
                "resolved_at": f.resolved_at.isoformat() if f.resolved_at else None,
            }
            for f in (flags or [])
        ],
    }


@router.get("", summary="List vendors (screens 13a, 18a)")
async def list_vendors(
    user: BuyerDep,
    session: SessionDep,
    page: PaginationDep,
    status_filter: VendorStatus | None = Query(None, alias="status"),
    search: str | None = Query(None, max_length=200),
) -> dict[str, Any]:
    repo = VendorRepository(session)
    rows, total = await repo.list_for_org(
        user.org_id,
        status=status_filter,
        search=search,
        limit=page.limit,
        offset=page.offset,
    )
    # One query for every vendor's flags, not one per vendor. The screen
    # already knows all the ids it cares about.
    flags = await repo.flags_for_vendors([v.id for v in rows])
    items = [_serialize(v, flags.get(v.id, [])) for v in rows]
    return {"items": items, "total": total, "limit": page.limit, "offset": page.offset}


@router.post("", status_code=status.HTTP_201_CREATED, summary="Add a vendor (13a)")
async def create_vendor(
    body: VendorCreate, user: BuyerDep, session: SessionDep
) -> dict[str, Any]:
    """Employee-submitted vendors land PENDING. Verification is an admin act."""
    vendor = await VendorRepository(session).create(
        org_id=user.org_id,
        created_by=user.id,
        status=VendorStatus.PENDING.value,
        **body.model_dump(),
    )
    return _serialize(vendor)


@router.get("/{vendor_id}", summary="Vendor detail")
async def get_vendor(
    vendor_id: UUID, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    repo = VendorRepository(session)
    vendor = await repo.get(vendor_id)
    if vendor is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "vendor not found")
    # A vendor may read only its own profile.
    if user.role is UserRole.VENDOR and vendor.user_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "not your vendor profile")
    return _serialize(vendor, list(await repo.open_flags(vendor_id)))


@router.patch("/{vendor_id}/status", summary="Verify / suspend / reinstate (18a)")
async def set_vendor_status(
    vendor_id: UUID, body: VendorStatusUpdate, user: AdminDep, session: SessionDep
) -> dict[str, Any]:
    repo = VendorRepository(session)
    vendor = await repo.get(vendor_id)
    if vendor is None or (user.org_id and vendor.org_id != user.org_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "vendor not found")
    await repo.set_status(vendor, body.status, actor_id=user.id, reason=body.reason)
    return _serialize(vendor)


@router.delete("/{vendor_id}", summary="Delete a vendor (18a)")
async def delete_vendor(
    vendor_id: UUID, user: AdminDep, session: SessionDep
) -> dict[str, Any]:
    """Deletion is refused once the vendor appears in any quote.

    The FK from quotes is ON DELETE RESTRICT precisely so an audit trail can
    never lose its counterparty; suspend such a vendor instead.
    """
    repo = VendorRepository(session)
    vendor = await repo.get(vendor_id)
    if vendor is None or (user.org_id and vendor.org_id != user.org_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "vendor not found")
    try:
        await repo.delete(vendor_id)
        await session.commit()
    except Exception:
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "this vendor appears in quotes or purchase orders and cannot be "
            "deleted without destroying audit history; suspend it instead",
        ) from None
    return {"deleted": True, "id": str(vendor_id)}


# --------------------------------------------------------------------------
# Vendor-side: own purchase orders and delivery status
# --------------------------------------------------------------------------
@router.get("/me/purchase-orders", summary="POs addressed to me (vendor)")
async def my_purchase_orders(
    vendor_id: VendorIdDep,
    session: SessionDep,
    page: PaginationDep,
    status_filter: PODeliveryStatus | None = Query(None, alias="status"),
) -> dict[str, Any]:
    rows, total = await PurchaseOrderRepository(session).for_vendor(
        vendor_id, status=status_filter, limit=page.limit, offset=page.offset
    )
    return {
        "items": [
            {
                "id": str(po.id),
                "po_number": po.po_number,
                "total_amount": float(po.total_amount),
                "currency": po.currency,
                "delivery_status": po.delivery_status,
                "expected_delivery_date": (
                    po.expected_delivery_date.isoformat()
                    if po.expected_delivery_date
                    else None
                ),
                "delivered_at": po.delivered_at.isoformat() if po.delivered_at else None,
                "created_at": po.created_at.isoformat(),
                # A supplier cannot fulfil an order without its terms, and
                # cannot file it without the document itself.
                "delivery_days": po.delivery_days,
                "warranty_months": po.warranty_months,
                "payment_terms": po.payment_terms,
                "delivery_address": po.delivery_address,
                "notes": po.notes,
                "quantity_delivered": po.quantity_delivered,
                "pdf_url": signed_pdf_url(po.pdf_path),
                # What this vendor may do next, so the portal renders the
                # real options rather than a fixed set it has to guess at.
                "next_states": [
                    s.value
                    for s in PODeliveryStatus(po.delivery_status).next_states
                ],
                # A supplier needs to know the buyer has closed the order,
                # and why -- otherwise it sits in their queue looking open.
                "closed_at": po.closed_at.isoformat() if po.closed_at else None,
                "closure_outcome": po.closure_outcome,
                "closure_note": po.closure_note,
                "received_quantity": po.received_quantity,
                # Same shape as the buyer-side PO endpoint: one concept,
                # one payload shape, whoever is asking.
                "line_items": [
                    {
                        "line_number": li.line_number,
                        "description": li.description,
                        "sku": li.sku,
                        "quantity": li.quantity,
                        "unit_price": float(li.unit_price),
                        "line_total": float(li.line_total),
                    }
                    for li in po.line_items
                ],
            }
            for po in rows
        ],
        "total": total,
        "limit": page.limit,
        "offset": page.offset,
    }


@router.patch(
    "/me/purchase-orders/{po_id}/delivery",
    summary="Update delivery status (feeds reliability scoring)",
)
async def update_delivery(
    po_id: UUID,
    body: DeliveryStatusUpdate,
    vendor_id: VendorIdDep,
    session: SessionDep,
) -> dict[str, Any]:
    repo = PurchaseOrderRepository(session)
    po = await repo.get(po_id)
    if po is None or po.vendor_id != vendor_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "purchase order not found")

    # Fulfilment only moves forward. Every write appends a fulfilment event,
    # and those events are what a vendor's reliability is computed from -- so
    # an order that can be delivered twice, or un-delivered, is an order whose
    # reliability figure can be manufactured.
    current = PODeliveryStatus(po.delivery_status)
    if not current.can_move_to(body.delivery_status):
        allowed = [s.value for s in current.next_states]
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            (
                f"cannot move from {current.value} to "
                f"{body.delivery_status.value}"
                + (f"; allowed: {', '.join(allowed)}" if allowed
                   else "; this order is closed")
            ),
        )

    await repo.update_delivery(
        po,
        status=body.delivery_status,
        quantity_delivered=body.quantity_delivered,
        delivered_at=body.delivered_at,
        note=body.note,
    )
    return {
        "id": str(po.id),
        "po_number": po.po_number,
        "delivery_status": po.delivery_status,
        "delivered_at": po.delivered_at.isoformat() if po.delivered_at else None,
        "quantity_delivered": po.quantity_delivered,
        "next_states": [s.value for s in PODeliveryStatus(po.delivery_status).next_states],
    }
