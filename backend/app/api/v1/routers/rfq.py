"""Request for quotation — the path out of the dead end.

    POST /workflows/{id}/quote-requests   buyer asks; vendors are notified
    GET  /workflows/{id}/quote-requests   the request and every reply
    POST /quote-requests/{id}/close       buyer stops taking replies

    GET  /quote-requests/me               vendor: what I have been asked
    POST /quote-requests/{id}/respond     vendor: my prices
    POST /quote-requests/{id}/decline     vendor: cannot supply this

Until now, a workflow that escalated because nothing in the catalog matched —
or because nothing came in under budget — was finished. The catalog held no
answer and there was no way to ask for one.

THE AGENT IS UNCHANGED. It still only ever reads the catalog, which is what
keeps a run fast, deterministic and replayable. A vendor's reply is written
into that vendor's catalog with ``source='rfq'``; ``POST /workflows/{id}/run``
already accepts a workflow in ``escalated``; so re-running picks the new
prices up through the ordinary ``catalog_query`` path. No node changed, no
edge changed, no new tool.
"""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import (
    BuyerDep,
    CurrentUserDep,
    SessionDep,
    VendorDep,
    VendorIdDep,
)
from app.core.config import settings
from app.repositories.catalog_repo import CatalogRepository, VendorRepository
from app.repositories.device_repo import DeviceRepository
from app.repositories.notification_repo import NotificationRepository
from app.repositories.rfq_repo import QuoteRequestRepository
from app.repositories.workflow_repo import WorkflowRepository
from app.schemas.enums import (
    CatalogSourceKind,
    QuoteRequestStatus,
    QuoteResponseStatus,
    UserRole,
)
from app.schemas.rfq import (
    QuoteRequestCreate,
    QuoteResponseDecline,
    QuoteResponseSubmit,
)

router = APIRouter(tags=["quote requests"])


# --------------------------------------------------------------------------
# Serialisation
# --------------------------------------------------------------------------
def _response_json(row, vendor_name: str | None = None) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "vendor_id": str(row.vendor_id),
        "vendor_name": vendor_name,
        "status": row.status,
        "lines": row.lines_json or [],
        "total_amount": float(row.total_amount) if row.total_amount is not None else None,
        "currency": row.currency,
        "delivery_days": row.delivery_days,
        "warranty_months": row.warranty_months,
        "note": row.note,
        "decline_reason": row.decline_reason,
        "published_to_catalog": row.published_to_catalog,
        "invited_at": row.invited_at.isoformat(),
        "responded_at": row.responded_at.isoformat() if row.responded_at else None,
    }


def _request_json(
    request,
    *,
    names: dict[UUID, str] | None = None,
    workflow_title: str | None = None,
    include_responses: bool = True,
) -> dict[str, Any]:
    names = names or {}
    responses = (
        [_response_json(r, names.get(r.vendor_id)) for r in request.responses]
        if include_responses
        else []
    )
    responded = sum(
        1 for r in responses if r["status"] == QuoteResponseStatus.RESPONDED.value
    )
    declined = sum(
        1 for r in responses if r["status"] == QuoteResponseStatus.DECLINED.value
    )
    invited = len(responses)

    parts = [f"Asked {invited} supplier{'' if invited == 1 else 's'}",
             f"{responded} replied"]
    if declined:
        parts.append(f"{declined} declined")

    return {
        "id": str(request.id),
        "workflow_id": str(request.workflow_id),
        "workflow_title": workflow_title,
        "status": request.status,
        "reason": request.reason,
        "note": request.note,
        "items": request.items_json or [],
        "currency": request.currency,
        "budget": float(request.budget) if request.budget is not None else None,
        "closes_at": request.closes_at.isoformat() if request.closes_at else None,
        "created_at": request.created_at.isoformat(),
        "closed_at": request.closed_at.isoformat() if request.closed_at else None,
        "responses": responses,
        "invited_count": invited,
        "responded_count": responded,
        "summary_line": " · ".join(parts),
        # Drives the "Re-run with these quotes" affordance. Re-running before
        # anything is published just reproduces the same escalation.
        "is_actionable": any(
            r["status"] == QuoteResponseStatus.RESPONDED.value
            and r["published_to_catalog"]
            for r in responses
        ),
    }


# --------------------------------------------------------------------------
# Buyer side
# --------------------------------------------------------------------------
@router.post(
    "/workflows/{workflow_id}/quote-requests",
    status_code=status.HTTP_201_CREATED,
    summary="Ask vendors to quote on a workflow that found nothing",
)
async def create_quote_request(
    workflow_id: UUID,
    body: QuoteRequestCreate,
    user: BuyerDep,
    session: SessionDep,
) -> dict[str, Any]:
    workflows = WorkflowRepository(session)
    workflow = await workflows.get_visible(
        workflow_id,
        requester_id=user.id,
        org_id=user.org_id,
        is_admin=user.is_admin,
    )
    if workflow is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workflow not found")

    repo = QuoteRequestRepository(session)

    # Asking twice should reach the same suppliers with the same question,
    # not fragment the replies across two rows the buyer must reconcile.
    existing = await repo.open_for_workflow(workflow_id)
    if existing is not None:
        names = await repo.vendor_names(existing)
        return _request_json(existing, names=names, workflow_title=workflow.title)

    invitees = list(body.vendor_ids or [])
    if not invitees:
        invitees = await repo.invitable_vendor_ids(user.org_id)
    if not invitees:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "there are no verified vendors to ask; add and verify a vendor first",
        )

    entities = workflow.entities_json or {}
    items = entities.get("items") or []
    budget = entities.get("budget")

    request = await repo.create_request(
        workflow_id=workflow_id,
        org_id=user.org_id,
        requested_by=user.id,
        vendor_ids=invitees,
        # The vendor deserves to know which problem they are solving: "nothing
        # in the catalog matches" reads very differently from "everyone was
        # over budget".
        reason=workflow.escalation_reason,
        note=body.note,
        items=items,
        currency=workflow.currency or settings.default_currency,
        # entities_json is a stored blob: rows written before the planner's
        # serializer fix hold the budget as a string.
        budget=Decimal(str(budget)) if budget not in (None, "") else None,
        respond_within_hours=body.respond_within_hours,
    )

    # -- tell the vendors -------------------------------------------------
    devices = DeviceRepository(session)
    vendor_user_ids: list[UUID] = []
    tokens: list[str] = []
    for vendor_id in invitees:
        user_id = await devices.vendor_user_id(vendor_id)
        if user_id:
            vendor_user_ids.append(user_id)
        tokens += await devices.tokens_for_vendor(vendor_id)

    summary = ", ".join(
        f"{i.get('quantity', '?')} × {i.get('name', 'item')}" for i in items[:3]
    ) or "a new requirement"
    if len(items) > 3:
        summary += f" and {len(items) - 3} more"

    await NotificationRepository(session).fan_out(
        user_ids=vendor_user_ids,
        org_id=user.org_id,
        kind="quote_requested",
        title="A buyer is asking for a quote",
        body=f"{summary}. Reply with your price to be considered.",
        deep_link=f"agentflow://quote-requests/{request.id}",
        workflow_id=workflow_id,
    )
    await session.commit()

    if tokens:
        # Push is best-effort: the invitation is already recorded and visible
        # in the portal, so a push failure must not fail the request.
        from app.agent.tools.notification import NotificationPayload, send_push

        try:
            await send_push(
                NotificationPayload(
                    kind="quote_requested",
                    title="A buyer is asking for a quote",
                    body=summary,
                    fcm_tokens=sorted(set(tokens)),
                    deep_link=f"agentflow://quote-requests/{request.id}",
                    data={"quote_request_id": str(request.id)},
                )
            )
        except Exception:  # noqa: BLE001 - never fail the ask on a push
            pass

    await session.refresh(request)
    names = await repo.vendor_names(request)
    return _request_json(request, names=names, workflow_title=workflow.title)


@router.get(
    "/workflows/{workflow_id}/quote-requests",
    summary="The quote request for a workflow, with every reply",
)
async def get_quote_request(
    workflow_id: UUID, user: BuyerDep, session: SessionDep
) -> dict[str, Any]:
    workflow = await WorkflowRepository(session).get_visible(
        workflow_id,
        requester_id=user.id,
        org_id=user.org_id,
        is_admin=user.is_admin,
    )
    if workflow is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workflow not found")

    repo = QuoteRequestRepository(session)
    await repo.expire_overdue(user.org_id)
    request = await repo.latest_for_workflow(workflow_id)
    if request is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "no quote request has been raised for this workflow",
        )
    await session.commit()
    names = await repo.vendor_names(request)
    return _request_json(request, names=names, workflow_title=workflow.title)


@router.post(
    "/quote-requests/{request_id}/close",
    summary="Stop taking replies",
)
async def close_quote_request(
    request_id: UUID, user: BuyerDep, session: SessionDep
) -> dict[str, Any]:
    repo = QuoteRequestRepository(session)
    request = await repo.get(request_id)
    if request is None or (user.org_id and request.org_id != user.org_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "quote request not found")
    await repo.close(request)
    await session.commit()
    names = await repo.vendor_names(request)
    return _request_json(request, names=names)


# --------------------------------------------------------------------------
# Vendor side
# --------------------------------------------------------------------------
@router.get(
    "/quote-requests/me",
    summary="Quote requests addressed to me (vendor)",
)
async def my_quote_requests(
    vendor_id: VendorIdDep,
    session: SessionDep,
    include_closed: bool = Query(False),
) -> dict[str, Any]:
    """Only ever this vendor's own row of each request.

    A supplier never sees what a competitor quoted -- that isolation is the
    whole reason responses are per-vendor rows rather than one document.
    """
    repo = QuoteRequestRepository(session)
    # Only this vendor's invitations. Unscoped, a supplier opening their inbox
    # expired quote requests belonging to organisations they have never heard
    # of -- a read on one tenant writing to another.
    await repo.expire_overdue(vendor_id=vendor_id)
    await session.commit()

    rows = await repo.for_vendor(vendor_id, include_closed=include_closed)
    items = []
    for request, mine, workflow_title in rows:
        payload = _request_json(
            request, workflow_title=workflow_title, include_responses=False
        )
        payload["my_response"] = _response_json(mine)
        # Recomputed without the other vendors' rows, which are not loaded.
        payload.pop("summary_line", None)
        payload.pop("is_actionable", None)
        payload.pop("invited_count", None)
        payload.pop("responded_count", None)
        items.append(payload)

    return {"items": items, "total": len(items)}


def _catalog_values(
    line: dict[str, Any], currency: str, requested_quantity: int | None = None
) -> dict[str, Any]:
    """A quoted line as a catalog row.

    Published immediately: an unpublished answer is invisible to the agent,
    and a vendor who took the trouble to quote plainly means to be considered.

    CATEGORY IS THE REQUESTED ITEM NAME, and that is not cosmetic.
    ``CatalogRepository.find_offers`` matches by ILIKE over title,
    description, category and brand -- deliberately, so the same request
    produces the same quotes every run. A vendor answering a request for
    "laptops" with a row titled "Dell Latitude 5550 (RFQ special)" would
    therefore match nothing: they did everything right and would still never
    be considered. Writing the requested term into category and description
    makes the match deterministic, and it is an honest claim -- the vendor is
    asserting that this row answers that request.
    """
    requested = str(line.get("request_item_name") or "").strip()
    return {
        "title": line["title"],
        # Both columns are searched. Category carries the bare term for the
        # match; description says where the row came from, for a human
        # reading the catalog later and wondering.
        "category": requested or None,
        "description": (
            f"Quoted in response to a request for {requested}."
            if requested
            else "Quoted in response to a buyer's request."
        ),
        "price": Decimal(str(line["unit_price"])),
        "currency": currency,
        # Quantity is optional on a quote line. Defaulting published stock to
        # zero made the row invisible to the agent -- find_offers requires
        # stock >= the requested quantity -- so a vendor could quote, be told
        # it was published, and the buyer's re-run would still find nothing.
        # An omitted quantity means "I can supply what you asked for".
        "stock": int(line.get("quantity") or requested_quantity or 0),
        "delivery_days": line.get("delivery_days"),
        "warranty_months": line.get("warranty_months"),
        "visible": True,
        "source": CatalogSourceKind.RFQ.value,
        "published_at": datetime.now(UTC),
        "has_unpublished_changes": False,
    }


@router.post(
    "/quote-requests/{request_id}/respond",
    summary="Submit my prices (vendor)",
)
async def respond_to_quote_request(
    request_id: UUID,
    body: QuoteResponseSubmit,
    user: VendorDep,
    vendor_id: VendorIdDep,
    session: SessionDep,
) -> dict[str, Any]:
    repo = QuoteRequestRepository(session)
    request = await repo.get(request_id)
    if request is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "quote request not found")

    mine = await repo.response_for(request_id, vendor_id)
    if mine is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "you were not invited to this quote request"
        )
    if request.status != QuoteRequestStatus.OPEN.value:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"this quote request is {request.status} and is no longer taking replies",
        )

    lines = [line.model_dump(mode="json") for line in body.lines]
    available = [line for line in lines if line.get("available")]

    total = sum(
        Decimal(str(line["unit_price"])) * int(line.get("quantity") or 0)
        for line in available
        if line.get("unit_price") is not None
    )
    lead_times = [
        line["delivery_days"] for line in available if line.get("delivery_days") is not None
    ]
    warranties = [
        line["warranty_months"]
        for line in available
        if line.get("warranty_months") is not None
    ]

    mine.status = QuoteResponseStatus.RESPONDED.value
    mine.lines_json = lines
    mine.total_amount = total or None
    mine.currency = request.currency
    # The order lands when its slowest line lands, and the warranty a buyer
    # can rely on is the shortest one — take the pessimistic figure for both.
    mine.delivery_days = body.delivery_days if body.delivery_days is not None else (
        max(lead_times) if lead_times else None
    )
    mine.warranty_months = body.warranty_months if body.warranty_months is not None else (
        min(warranties) if warranties else None
    )
    mine.note = body.note
    mine.decline_reason = None
    mine.responded_at = datetime.now(UTC)

    # -- publish into the catalog, which is what the agent reads ----------
    published = 0
    if body.publish_to_catalog:
        catalog = CatalogRepository(session)
        # What the buyer asked for, by item name, so a quote line that omits
        # its own quantity still publishes enough stock to be considered.
        wanted = {
            str(item.get("name") or "").strip().lower(): item.get("quantity")
            for item in (request.items_json or [])
        }
        for line in available:
            await catalog.upsert_by_sku(
                vendor_id,
                line["sku"],
                _catalog_values(
                    line,
                    request.currency,
                    wanted.get(
                        str(line.get("request_item_name") or "").strip().lower()
                    ),
                ),
            )
            published += 1
        mine.published_to_catalog = published > 0

        vendors = VendorRepository(session)
        vendor = await vendors.get(vendor_id)
        if vendor is not None:
            vendor.last_published_at = datetime.now(UTC)

    # -- tell the buyer ---------------------------------------------------
    vendor = await VendorRepository(session).get(vendor_id)
    vendor_name = vendor.name if vendor else "A supplier"
    if request.requested_by:
        await NotificationRepository(session).fan_out(
            user_ids=[request.requested_by],
            org_id=request.org_id,
            kind="quote_received",
            title=f"{vendor_name} replied to your quote request",
            body=(
                f"{len(available)} line(s) quoted"
                + (f", {request.currency} {total:,.0f} total" if total else "")
                + ("." if published else ", not published to the catalog.")
            ),
            deep_link=f"agentflow://workflows/{request.workflow_id}",
            workflow_id=request.workflow_id,
        )

    await session.commit()
    await session.refresh(mine)
    return {
        "response": _response_json(mine, vendor_name),
        "catalog_items_published": published,
        # Said plainly, because it is the difference between being considered
        # and not: the agent reads the catalog and nothing else.
        "detail": (
            f"{published} item(s) published to your catalog. The buyer can now "
            "re-run the request and the agent will see your prices."
            if published
            else "Your reply was recorded but not published to your catalog, so "
            "the agent cannot quote it. The buyer must read it by hand."
        ),
    }


@router.post(
    "/quote-requests/{request_id}/decline",
    summary="Decline to quote (vendor)",
)
async def decline_quote_request(
    request_id: UUID,
    body: QuoteResponseDecline,
    vendor_id: VendorIdDep,
    session: SessionDep,
) -> dict[str, Any]:
    """Declining is worth recording.

    "Cannot supply this" is a real answer, and a buyer staring at silence
    cannot tell it apart from a vendor who simply has not looked yet.
    """
    repo = QuoteRequestRepository(session)
    mine = await repo.response_for(request_id, vendor_id)
    if mine is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "you were not invited to this quote request"
        )
    mine.status = QuoteResponseStatus.DECLINED.value
    mine.decline_reason = body.reason
    mine.responded_at = datetime.now(UTC)
    await session.commit()
    return {"response": _response_json(mine)}


# --------------------------------------------------------------------------
# Vendor bell count -- so the portal can badge the invitations
# --------------------------------------------------------------------------
@router.get(
    "/quote-requests/me/count",
    summary="How many open invitations I have not answered",
)
async def my_open_invite_count(
    vendor_id: VendorIdDep, session: SessionDep
) -> dict[str, int]:
    repo = QuoteRequestRepository(session)
    return {"open": await repo.open_invite_count(vendor_id)}


# --------------------------------------------------------------------------
# Guard: a non-vendor hitting the vendor routes gets a useful 403, not a 500
# --------------------------------------------------------------------------
@router.get("/quote-requests/{request_id}", summary="One quote request")
async def get_one(
    request_id: UUID, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    repo = QuoteRequestRepository(session)
    request = await repo.get(request_id)
    if request is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "quote request not found")

    if user.role is UserRole.VENDOR:
        if user.vendor_id is None:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "no vendor profile is linked to this account",
            )
        mine = await repo.response_for(request_id, user.vendor_id)
        if mine is None:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "you were not invited to this quote request"
            )
        payload = _request_json(request, include_responses=False)
        payload["my_response"] = _response_json(mine)
        return payload

    if user.org_id and request.org_id != user.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "quote request not found")
    names = await repo.vendor_names(request)
    return _request_json(request, names=names)
