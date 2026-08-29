"""Approval endpoints -- the human gate (screens 8a, 8b, 12a).

THE AGENT NEVER AUTO-APPROVES. This router is the only route by which a
workflow leaves AWAITING_APPROVAL, the decision requires the ADMIN role, and
it is recorded against the deciding user before the graph resumes.

Reading the queue is deliberately wider than deciding on it. An employee may
see the approvals raised for their OWN requests -- that is the design's
Approvals tab, and being able to watch your own request sit at the gate is not
the same power as clearing it. ``decide`` stays admin-only.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

import structlog
from fastapi import APIRouter, HTTPException, status

from app.agent.tools.notification import NotificationPayload, send_push
from app.api.deps import AdminDep, CurrentUserDep, PaginationDep, SessionDep
from app.core.config import settings
from app.db.models import User
from app.repositories.catalog_repo import VendorRepository
from app.repositories.device_repo import DeviceRepository
from app.repositories.notification_repo import NotificationRepository
from app.repositories.procurement_repo import (
    ApprovalRepository,
    PurchaseOrderRepository,
)
from app.repositories.workflow_repo import WorkflowRepository
from app.schemas.admin import ApprovalDecisionRequest
from app.schemas.enums import UserRole
from app.services import workflow_service

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/approvals", tags=["approvals"])


def signed_pdf_url(pdf_path: str | None) -> str | None:
    """A short-lived link to the stored purchase order.

    The bucket is private -- a purchase order is a commercial document -- so
    the only way to read one is a signed URL that expires. Returns None rather
    than raising: an approval is still reviewable without the PDF, and a
    Storage outage must not block a decision.
    """
    if not pdf_path or not settings.supabase_configured:
        return None
    try:
        from supabase import create_client

        client = create_client(
            settings.supabase_url, settings.supabase_service_role_key
        )
        signed = client.storage.from_(
            settings.supabase_storage_bucket
        ).create_signed_url(pdf_path, settings.signed_url_expiry_seconds)
        return signed.get("signedURL") or signed.get("signed_url")
    except Exception as exc:  # noqa: BLE001 - the PO is usable without a link
        log.warning("approvals.signed_url_failed", error=str(exc), path=pdf_path)
        return None


def _percent(total: float | None, budget: float | None) -> float | None:
    if not total or not budget:
        return None
    return round(total / budget * 100, 1)


# --------------------------------------------------------------------------
# Queue
# --------------------------------------------------------------------------
@router.get("", summary="Approval queue (screen 8a)")
async def list_approvals(
    user: CurrentUserDep, session: SessionDep, page: PaginationDep
) -> dict[str, Any]:
    """Admins see everything in their org; an employee sees only their own.

    A vendor sees nothing -- a supplier has no business reading the buyer's
    approval queue, which would expose what other suppliers were quoted.
    """
    if user.role is UserRole.VENDOR:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "vendors cannot read the approval queue"
        )

    # One joined query. Fetching the workflow, PO and vendor per row cost 58
    # round trips for 20 approvals -- thirteen seconds on a link to Tokyo.
    #
    # Scoping is pushed into the query too: an employee's queue is their own
    # requests, which is a WHERE clause, not a post-filter that would make
    # `total` and the page size lie.
    rows, total = await ApprovalRepository(session).queue_rows(
        user.org_id,
        requester_id=None if user.role is UserRole.ADMIN else user.id,
        limit=page.limit,
        offset=page.offset,
    )

    items = []
    for row in rows:
        a, wf = row["approval"], row["workflow"]
        po, vendor = row["purchase_order"], row["vendor"]
        total_amount = float(po.total_amount) if po else None
        budget = float(wf.budget) if wf and wf.budget else None

        items.append(
            {
                "id": str(a.id),
                "workflow_id": str(a.workflow_id),
                "purchase_order_id": (
                    str(a.purchase_order_id) if a.purchase_order_id else None
                ),
                "decision": a.decision,
                "requested_at": a.requested_at.isoformat(),
                "title": wf.title if wf else "",
                "budget": budget,
                "currency": wf.currency if wf else None,
                "total_amount": total_amount,
                "po_number": po.po_number if po else None,
                "vendor_name": vendor.name if vendor else None,
                "budget_utilisation": _percent(total_amount, budget),
                # An employee viewing their own request cannot act on it.
                "can_decide": user.role is UserRole.ADMIN,
            }
        )
    return {"items": items, "total": total, "limit": page.limit, "offset": page.offset}


# --------------------------------------------------------------------------
# Detail -- everything screen 12a renders
# --------------------------------------------------------------------------
@router.get("/{approval_id}", summary="Full PO detail for review (screen 12a)")
async def get_approval(
    approval_id: UUID, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    if user.role is UserRole.VENDOR:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "not visible to vendors")

    # One join for approval + workflow + purchase order + vendor + requester.
    # These were five sequential lookups, which on a ~200 ms link is a second
    # of latency before the screen can draw anything.
    row = await ApprovalRepository(session).detail_row(approval_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "approval not found")

    approval, wf = row["approval"], row["workflow"]
    po, vendor, requester = row["purchase_order"], row["vendor"], row["requester"]

    if user.org_id and approval.org_id != user.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "approval not found")
    if user.role is not UserRole.ADMIN and (wf is None or wf.requester_id != user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "approval not found")

    decided_by_name = None
    if approval.decided_by:
        decided_by_name = (
            requester.full_name or requester.email
            if requester is not None and requester.id == approval.decided_by
            else await _user_name(session, approval.decided_by)
        )

    total_amount = float(po.total_amount) if po else None
    budget = float(wf.budget) if wf and wf.budget else None

    # Flat mirrors of the nested values.
    #
    # A push notification can launch this screen cold, with no queue loaded to
    # inherit a row from, so the detail response has to be parseable by the
    # same client model the queue produces. Without these the deep-linked
    # screen opened blank.
    return {
        "id": str(approval.id),
        "workflow_id": str(approval.workflow_id),
        "purchase_order_id": (
            str(approval.purchase_order_id) if approval.purchase_order_id else None
        ),
        "decision": approval.decision,
        "requested_at": approval.requested_at.isoformat(),
        "decided_at": approval.decided_at.isoformat() if approval.decided_at else None,
        "decided_by": str(approval.decided_by) if approval.decided_by else None,
        "decided_by_name": decided_by_name,
        "comment": approval.comment,
        "title": wf.title if wf else "",
        "budget": budget,
        "currency": (wf.currency if wf else None) or settings.default_currency,
        "total_amount": total_amount,
        "po_number": po.po_number if po else None,
        "vendor_name": vendor.name if vendor else None,
        "requester_name": (
            (requester.full_name or requester.email) if requester else None
        ),
        "budget_utilisation": _percent(total_amount, budget),
        "justification": wf.justification if wf else None,
        "pdf_url": signed_pdf_url(po.pdf_path if po else None),
        "can_decide": user.role is UserRole.ADMIN,
        "workflow": (
            {
                "id": str(wf.id),
                "title": wf.title,
                "request_text": wf.request_text,
                "budget": budget,
                "currency": wf.currency,
                "status": wf.status,
                "justification": wf.justification,
            }
            if wf
            else None
        ),
        "purchase_order": (
            {
                "id": str(po.id),
                "po_number": po.po_number,
                "vendor_name": vendor.name if vendor else None,
                "subtotal": float(po.subtotal),
                "tax": float(po.tax),
                "total_amount": float(po.total_amount),
                "currency": po.currency,
                "delivery_days": po.delivery_days,
                "expected_delivery_date": (
                    po.expected_delivery_date.isoformat()
                    if po.expected_delivery_date
                    else None
                ),
                "warranty_months": po.warranty_months,
                "payment_terms": po.payment_terms,
                "pdf_url": signed_pdf_url(po.pdf_path),
                "line_items": [
                    {
                        "line_number": li.line_number,
                        "description": li.description,
                        "sku": li.sku,
                        "quantity": li.quantity,
                        "unit_price": float(li.unit_price),
                        "line_total": float(li.line_total),
                        "delivery_days": li.delivery_days,
                        "warranty_months": li.warranty_months,
                    }
                    for li in po.line_items
                ],
            }
            if po
            else None
        ),
    }


# --------------------------------------------------------------------------
# Decision
# --------------------------------------------------------------------------
@router.post("/{approval_id}/decision", summary="Approve or reject (screen 8b)")
async def decide(
    approval_id: UUID,
    body: ApprovalDecisionRequest,
    user: AdminDep,
    session: SessionDep,
) -> dict[str, Any]:
    """Record the decision, then resume the interrupted graph.

    Idempotent: a double-tap on Approve records once and resumes once.
    """
    repo = ApprovalRepository(session)
    approval = await repo.get(approval_id)
    if approval is None or (user.org_id and approval.org_id != user.org_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "approval not found")

    approval, changed = await repo.decide(
        approval,
        decision=body.decision,
        decided_by=user.id,
        comment=body.comment,
        idempotency_key=body.idempotency_key,
    )

    # Gather the notification recipients while the session is open, but send
    # after the commit -- a push about a decision that was then rolled back
    # would be worse than no push at all.
    #
    # The inbox rows go in BEFORE the commit, in the same transaction as the
    # decision itself. A bell that disagrees with what happened is worse than
    # a bell that is briefly empty.
    recipients: list[tuple[str, str, str, str, list[str]]] = []
    if changed:
        recipients = await _decision_recipients(session, approval, body.decision)
        await _record_inbox(session, approval, body.decision)

    await session.commit()

    resumed = False
    if changed:
        await workflow_service.resume_after_decision(
            workflow_id=approval.workflow_id,
            decision=body.decision,
            comment=body.comment,
        )
        resumed = True
        for kind, title, body_text, deep_link, tokens in recipients:
            if not tokens:
                continue
            result = await send_push(
                NotificationPayload(
                    kind=kind,  # type: ignore[arg-type]
                    title=title,
                    body=body_text,
                    fcm_tokens=tokens,
                    deep_link=deep_link,
                    data={"workflow_id": str(approval.workflow_id)},
                )
            )
            log.info(
                "approvals.notified",
                kind=kind,
                recipients=len(tokens),
                ok=result.ok,
                detail=result.detail,
            )

    return {
        "approval": {
            "id": str(approval.id),
            "workflow_id": str(approval.workflow_id),
            "decision": approval.decision,
            "decided_at": (
                approval.decided_at.isoformat() if approval.decided_at else None
            ),
            "decided_by": str(approval.decided_by) if approval.decided_by else None,
            "comment": approval.comment,
        },
        "resumed": resumed,
    }


async def _record_inbox(session, approval, decision: str) -> None:
    """Durable inbox rows, to the same people the push goes to.

    Written here rather than beside the send so they share the decision's
    transaction: if the decision rolls back, so do the notifications.
    """
    devices = DeviceRepository(session)
    notifications = NotificationRepository(session)
    wf = await WorkflowRepository(session).get(approval.workflow_id)
    approved = decision == "approved"
    verb = "approved" if approved else "rejected"

    if wf and wf.requester_id:
        await notifications.fan_out(
            user_ids=[wf.requester_id],
            org_id=wf.org_id,
            kind="approval_decided",
            title=f"Request {verb}",
            body=(
                f"{wf.title} was {verb}"
                f"{f' — {approval.comment}' if approval.comment else '.'}"
            ),
            deep_link=f"agentflow://workflows/{approval.workflow_id}",
            workflow_id=approval.workflow_id,
        )

    if approved and approval.purchase_order_id:
        po = await PurchaseOrderRepository(session).get(approval.purchase_order_id)
        if po is not None:
            vendor_user = await devices.vendor_user_id(po.vendor_id)
            if vendor_user is not None:
                await notifications.fan_out(
                    user_ids=[vendor_user],
                    org_id=wf.org_id if wf else None,
                    kind="po_issued",
                    title=f"New order {po.po_number}",
                    body=(
                        f"{po.currency} {float(po.total_amount):,.0f}"
                        + (
                            f" — delivery in {po.delivery_days} days."
                            if po.delivery_days
                            else ""
                        )
                    ),
                    deep_link=f"agentflow://purchase-orders/{po.id}",
                    workflow_id=approval.workflow_id,
                )


async def _decision_recipients(session, approval, decision: str):
    """Who to tell, and what to tell them.

    Two audiences that were previously told nothing:

      * the requester, whose run has been sitting at the gate. Both outcomes
        are news -- a rejection especially, since nothing further will happen.
      * the vendor, on approval only. A purchase order raised against their
        catalog is the first they would otherwise hear of it, and only once
        they happened to open the app.
    """
    devices = DeviceRepository(session)
    workflows = WorkflowRepository(session)
    wf = await workflows.get(approval.workflow_id)
    approved = decision == "approved"

    out = []

    if wf and wf.requester_id:
        tokens = await devices.tokens_for_user(wf.requester_id)
        out.append(
            (
                "approval_decided",
                f"Request {'approved' if approved else 'rejected'}",
                (
                    f"{wf.title} was {'approved' if approved else 'rejected'}"
                    f"{f' — {approval.comment}' if approval.comment else '.'}"
                ),
                f"agentflow://workflows/{approval.workflow_id}",
                tokens,
            )
        )

    if approved and approval.purchase_order_id:
        po = await PurchaseOrderRepository(session).get(approval.purchase_order_id)
        if po is not None:
            tokens = await devices.tokens_for_vendor(po.vendor_id)
            out.append(
                (
                    "po_issued",
                    f"New order {po.po_number}",
                    (
                        f"{po.currency} {float(po.total_amount):,.0f} — "
                        f"delivery in {po.delivery_days} days."
                        if po.delivery_days
                        else f"{po.currency} {float(po.total_amount):,.0f}"
                    ),
                    f"agentflow://purchase-orders/{po.id}",
                    tokens,
                )
            )

    return out


async def _user_name(session, user_id: UUID) -> str | None:
    user = await session.get(User, user_id)
    if user is None:
        return None
    return user.full_name or user.email
