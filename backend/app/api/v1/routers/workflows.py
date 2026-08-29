"""Workflow endpoints -- the employee demo path.

    POST /workflows              2a  plan only, nothing executes
    POST /workflows/{id}/run     3a  user confirmed; execution begins
    GET  /workflows/{id}         4a  live state (REST fallback for the socket)
    GET  /workflows/{id}/comparison  5a / 11a
    GET  /workflows/{id}/validation  6a / 6b
    GET  /workflows/{id}/purchase-order  7a
    GET  /workflows/{id}/report      9a
    GET  /workflows/{id}/audit       10b
    GET  /workflows                  10a  history, filterable
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import BuyerDep, CurrentUserDep, PaginationDep, SessionDep
from app.core.config import settings
from app.repositories.device_repo import DeviceRepository
from app.repositories.notification_repo import NotificationRepository
from app.repositories.procurement_repo import (
    PurchaseOrderRepository,
    QuoteRepository,
    ValidationRepository,
)
from app.repositories.workflow_repo import StepRepository, WorkflowRepository
from app.schemas.enums import (
    POClosureOutcome,
    PODeliveryStatus,
    UserRole,
    WorkflowStatus,
    WorkflowType,
)
from app.schemas.rfq import PurchaseOrderClose
from app.schemas.workflow import (
    CreateWorkflowRequest,
    WorkflowPlanResponse,
)
from app.services import workflow_service

router = APIRouter(prefix="/workflows", tags=["workflows"])


async def _load_visible(
    workflow_id: UUID, user: CurrentUserDep, session: SessionDep
):
    """Fetch a workflow the caller is allowed to see, or 404.

    Vendors get no path here at all: buyer workflows are invisible to them.
    """
    if user.role is UserRole.VENDOR:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="vendors cannot access buyer workflows",
        )
    workflow = await WorkflowRepository(session).get_visible(
        workflow_id,
        requester_id=user.id,
        org_id=user.org_id,
        is_admin=user.is_admin,
    )
    if workflow is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="workflow not found"
        )
    return workflow


@router.post(
    "",
    response_model=WorkflowPlanResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Submit a request and get an execution plan (nothing runs yet)",
)
async def create_workflow(
    body: CreateWorkflowRequest, user: CurrentUserDep
) -> WorkflowPlanResponse:
    """Screen 2a.

    The body carries free text only. There is deliberately no workflow_type
    field: the planner infers it from the text, which is the generalizability
    claim. Execution begins only when the user confirms on screen 3a.
    """
    if user.role is UserRole.VENDOR:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="vendors cannot submit buyer requests",
        )
    try:
        workflow, output, attempts = await workflow_service.plan_workflow(
            request_text=body.request_text,
            user=user,
            idempotency_key=body.idempotency_key,
        )
    except workflow_service.WorkflowServiceError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    return WorkflowPlanResponse(
        workflow_id=workflow.id,
        status=WorkflowStatus(workflow.status),
        summary=output.summary,
        entities=output.entities,
        plan=output.steps,
        planner_attempts=attempts,
    )


@router.post(
    "/{workflow_id}/run",
    summary="Confirm the plan and start execution",
    status_code=status.HTTP_202_ACCEPTED,
)
async def run_workflow(
    workflow_id: UUID, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    """Screen 3a -> 4a. Returns immediately; watch progress on the socket."""
    workflow = await _load_visible(workflow_id, user, session)
    if workflow.status not in {
        WorkflowStatus.DRAFT.value,
        WorkflowStatus.ESCALATED.value,
    }:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"workflow is {workflow.status}; only a draft can be run",
        )

    workflow_service.launch(workflow_id)
    return {
        "workflow_id": str(workflow_id),
        "status": WorkflowStatus.RUNNING.value,
        "stream": f"/ws/workflows/{workflow_id}",
        "poll": f"{settings.api_v1_prefix}/workflows/{workflow_id}",
    }


@router.get("", summary="Workflow history, filterable (screen 10a)")
async def list_workflows(
    # BuyerDep, not CurrentUserDep: a vendor must be refused outright rather
    # than handed an empty list. The empty result was only incidental -- it
    # came from the requester_id filter, not from an access decision.
    user: BuyerDep,
    session: SessionDep,
    page: PaginationDep,
    status_filter: WorkflowStatus | None = Query(None, alias="status"),
    workflow_type: WorkflowType | None = Query(None),
    search: str | None = Query(None, max_length=200),
    created_after: datetime | None = Query(None),
    created_before: datetime | None = Query(None),
) -> dict[str, Any]:
    rows, total = await WorkflowRepository(session).list_visible(
        requester_id=user.id,
        org_id=user.org_id,
        is_admin=user.is_admin,
        status=status_filter,
        workflow_type=workflow_type,
        search=search,
        created_after=created_after,
        created_before=created_before,
        limit=page.limit,
        offset=page.offset,
    )
    return {
        "items": [
            {
                "id": str(w.id),
                "title": w.title,
                "workflow_type": w.workflow_type,
                "status": w.status,
                "currency": w.currency,
                "total_amount": float(w.total_amount) if w.total_amount else None,
                "created_at": w.created_at.isoformat(),
                "completed_at": w.completed_at.isoformat() if w.completed_at else None,
                "duration_ms": w.duration_ms,
                "requester_id": str(w.requester_id),
            }
            for w in rows
        ],
        "total": total,
        "limit": page.limit,
        "offset": page.offset,
    }


@router.get("/{workflow_id}", summary="Full workflow state (screens 3a/4a/4b)")
async def get_workflow(
    workflow_id: UUID, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    """REST equivalent of the WebSocket stream, so the app degrades cleanly."""
    workflow = await _load_visible(workflow_id, user, session)
    # This is the screen that renders the tool log, so ask for it.
    steps = await StepRepository(session).for_workflow(
        workflow_id, with_tool_calls=True
    )
    done = sum(1 for s in steps if s.status == "completed")

    return {
        "id": str(workflow.id),
        "title": workflow.title,
        "request_text": workflow.request_text,
        "workflow_type": workflow.workflow_type,
        "status": workflow.status,
        "currency": workflow.currency,
        "budget": float(workflow.budget) if workflow.budget else None,
        "total_amount": float(workflow.total_amount) if workflow.total_amount else None,
        "entities": workflow.entities_json,
        "plan": workflow.plan_json,
        "summary": workflow.summary,
        "current_step_order": workflow.current_step_order,
        "self_correction_attempts": workflow.self_correction_attempts,
        "escalation_reason": workflow.escalation_reason,
        "progress_percent": int(round(done / len(steps) * 100)) if steps else 0,
        "created_at": workflow.created_at.isoformat(),
        "completed_at": workflow.completed_at.isoformat() if workflow.completed_at else None,
        "duration_ms": workflow.duration_ms,
        "steps": [
            {
                "id": str(s.id),
                "step_order": s.step_order,
                "name": s.name,
                "title": s.title,
                "description": s.description,
                "tool_name": s.tool_name,
                "status": s.status,
                "retry_count": s.retry_count,
                "max_retries": s.max_retries,
                "duration_ms": s.duration_ms,
                "error": s.error,
                "started_at": s.started_at.isoformat() if s.started_at else None,
                "completed_at": s.completed_at.isoformat() if s.completed_at else None,
                "tool_calls": [
                    {
                        "id": str(c.id),
                        "tool_name": c.tool_name,
                        "status": c.status,
                        "attempt": c.attempt,
                        "retry_count": c.retry_count,
                        "duration_ms": c.duration_ms,
                        "error": c.error,
                    }
                    for c in s.tool_calls
                ],
            }
            for s in steps
        ],
    }


@router.get(
    "/{workflow_id}/comparison",
    summary="Supplier comparison with full scoring (screens 5a / 11a)",
)
async def get_comparison(
    workflow_id: UUID, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    await _load_visible(workflow_id, user, session)
    quotes = await QuoteRepository(session).for_workflow(workflow_id)
    if not quotes:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="no quotes yet for this workflow",
        )
    return {
        "workflow_id": str(workflow_id),
        "quotes": [
            {
                "id": str(q.id),
                "vendor_id": str(q.vendor_id),
                "vendor_name": q.vendor_name,
                "status": q.status,
                "exclusion_reason": q.exclusion_reason,
                "total_amount": float(q.total_amount) if q.total_amount else None,
                "currency": q.currency,
                "delivery_days": q.delivery_days,
                "warranty_months": q.warranty_months,
                "items_covered": q.items_covered,
                "items_requested": q.items_requested,
                "score_total": float(q.score_total) if q.score_total else None,
                "score": q.score_json,
                "confidence_percent": q.confidence_percent,
                "missing_fields": q.missing_fields,
                "reliability_score": (
                    float(q.reliability_score) if q.reliability_score else None
                ),
                "reliability_has_history": q.reliability_has_history,
                "snapshot_taken_at": q.snapshot_taken_at.isoformat(),
                "lines": [
                    {
                        "request_item_name": ln.request_item_name,
                        "matched_title": ln.matched_title,
                        "sku": ln.sku,
                        "quantity": ln.quantity,
                        "available": ln.available,
                        "unit_price": float(ln.unit_price) if ln.unit_price else None,
                        "line_total": float(ln.line_total) if ln.line_total else None,
                        "delivery_days": ln.delivery_days,
                        "warranty_months": ln.warranty_months,
                    }
                    for ln in q.lines
                ],
            }
            for q in quotes
        ],
    }


@router.get(
    "/{workflow_id}/validation",
    summary="Validation report (screens 6a pass / 6b fail)",
)
async def get_validation(
    workflow_id: UUID, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    await _load_visible(workflow_id, user, session)
    report = await ValidationRepository(session).latest(workflow_id)
    if report is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="not validated yet"
        )
    return {
        "workflow_id": str(workflow_id),
        "purchase_order_id": (
            str(report.purchase_order_id) if report.purchase_order_id else None
        ),
        "attempt": report.attempt,
        "max_attempts": report.max_attempts,
        "passed": report.passed,
        "checks": report.checks_json,
        "validated_at": report.validated_at.isoformat(),
    }


@router.get(
    "/{workflow_id}/purchase-order",
    summary="Purchase order with a signed PDF URL (screen 7a)",
)
async def get_purchase_order(
    workflow_id: UUID, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    await _load_visible(workflow_id, user, session)
    po = await PurchaseOrderRepository(session).for_workflow(workflow_id)
    if po is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="no purchase order yet"
        )

    pdf_url = None
    if po.pdf_path and settings.supabase_configured:
        try:
            from supabase import create_client

            client = create_client(
                settings.supabase_url, settings.supabase_service_role_key
            )
            signed = client.storage.from_(
                settings.supabase_storage_bucket
            ).create_signed_url(po.pdf_path, settings.signed_url_expiry_seconds)
            pdf_url = signed.get("signedURL") or signed.get("signed_url")
        except Exception:  # noqa: BLE001 - the PO is still usable without a link
            pdf_url = None

    return {
        "id": str(po.id),
        "po_number": po.po_number,
        "workflow_id": str(po.workflow_id),
        "vendor_id": str(po.vendor_id),
        "quote_id": str(po.quote_id),
        "subtotal": float(po.subtotal),
        "tax": float(po.tax),
        "total_amount": float(po.total_amount),
        "currency": po.currency,
        "delivery_days": po.delivery_days,
        "expected_delivery_date": (
            po.expected_delivery_date.isoformat() if po.expected_delivery_date else None
        ),
        "warranty_months": po.warranty_months,
        "payment_terms": po.payment_terms,
        "delivery_status": po.delivery_status,
        "generation_attempt": po.generation_attempt,
        "pdf_url": pdf_url,
        # Close-out. Without these the app cannot tell an open order from a
        # closed one, and would keep offering a Close action on both.
        "closed_at": po.closed_at.isoformat() if po.closed_at else None,
        "closed_by": str(po.closed_by) if po.closed_by else None,
        "closure_outcome": po.closure_outcome,
        "closure_note": po.closure_note,
        "received_quantity": po.received_quantity,
        "created_at": po.created_at.isoformat(),
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


@router.post(
    "/{workflow_id}/purchase-order/close",
    summary="Close out a purchase order (buyer)",
)
async def close_purchase_order(
    workflow_id: UUID,
    body: PurchaseOrderClose,
    user: BuyerDep,
    session: SessionDep,
) -> dict[str, Any]:
    """The buyer's verdict on a delivered order.

    Deliberately NOT the same thing as ``PATCH /vendors/me/purchase-orders/
    {id}/delivery``. That endpoint is the SUPPLIER's account of the order;
    this is the BUYER's, recorded against the signed-in user. A vendor marking
    something delivered and a buyer confirming it arrived are different
    claims, and reliability scoring is only defensible when it can tell them
    apart -- until now every reliability figure rested on the supplier's own
    report of its performance.
    """
    await _load_visible(workflow_id, user, session)

    repo = PurchaseOrderRepository(session)
    po = await repo.for_workflow(workflow_id)
    if po is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="no purchase order yet"
        )
    if po.closed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"this purchase order was already closed on "
                f"{po.closed_at:%d %b %Y} as {po.closure_outcome}"
            ),
        )

    try:
        outcome = POClosureOutcome(body.outcome)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "outcome must be one of: "
                + ", ".join(o.value for o in POClosureOutcome)
            ),
        ) from None

    po.closed_at = datetime.now(UTC)
    po.closed_by = user.id
    po.closure_outcome = outcome.value
    po.closure_note = body.note
    po.received_quantity = body.received_quantity

    # Closing an order that the supplier never marked delivered is a real
    # situation -- goods arrive before the paperwork. Recording the buyer's
    # receipt keeps the supplier-side status honest rather than overwriting
    # it silently, so the two remain separately auditable.
    if (
        outcome is POClosureOutcome.COMPLETED
        and po.delivery_status != PODeliveryStatus.DELIVERED.value
    ):
        po.delivery_status = PODeliveryStatus.DELIVERED.value
        if po.delivered_at is None:
            po.delivered_at = po.closed_at
    elif outcome is POClosureOutcome.CANCELLED and not PODeliveryStatus(
        po.delivery_status
    ).is_terminal:
        # Otherwise an order the buyer cancelled still shows "In transit" in
        # the supplier's portal, with acknowledge and deliver chips that now
        # mean nothing.
        po.delivery_status = PODeliveryStatus.CANCELLED.value

    await session.flush()

    # Tell the supplier their order was closed, and how.
    vendor_user_id = await DeviceRepository(session).vendor_user_id(po.vendor_id)
    if vendor_user_id:
        await NotificationRepository(session).fan_out(
            user_ids=[vendor_user_id],
            org_id=user.org_id,
            kind="po_closed",
            title=f"{po.po_number} was closed",
            body=(
                f"The buyer closed this order as {outcome.value.replace('_', ' ')}."
                + (f" Note: {body.note}" if body.note else "")
            ),
            deep_link=f"agentflow://purchase-orders/{po.id}",
            workflow_id=workflow_id,
        )
    await session.commit()

    return {
        "id": str(po.id),
        "po_number": po.po_number,
        "closed_at": po.closed_at.isoformat(),
        "closed_by": str(po.closed_by),
        "closure_outcome": po.closure_outcome,
        "closure_note": po.closure_note,
        "received_quantity": po.received_quantity,
        "delivery_status": po.delivery_status,
    }


@router.get("/{workflow_id}/report", summary="Completion report (screen 9a)")
async def get_report(
    workflow_id: UUID, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    await _load_visible(workflow_id, user, session)
    return await workflow_service.build_completion_report(workflow_id)


@router.get("/{workflow_id}/audit", summary="Audit trail (screen 10b)")
async def get_audit(
    workflow_id: UUID, user: CurrentUserDep, session: SessionDep
) -> list[dict[str, Any]]:
    workflow = await _load_visible(workflow_id, user, session)
    # Hand over what the visibility check already loaded, rather than opening
    # a second session and re-reading the same row.
    return await workflow_service.build_audit_trail(
        workflow_id, session=session, workflow=workflow
    )
