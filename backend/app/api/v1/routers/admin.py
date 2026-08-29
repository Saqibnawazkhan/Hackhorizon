"""Admin endpoints -- dashboard, scoring config, policy rules, reports.

Screen 17a is the dashboard. The scoring-weight endpoints are what make
"weights are admin-configurable" true rather than aspirational: the values set
here are read by the scoring engine on the next run, with no redeploy.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import AdminDep, BuyerDep, SessionDep
from app.repositories.catalog_repo import VendorRepository
from app.repositories.procurement_repo import (
    ApprovalRepository,
    ConfigRepository,
    PurchaseOrderRepository,
)
from app.repositories.workflow_repo import WorkflowRepository
from app.schemas.admin import PolicyRuleCreate, ScoringWeights
from app.schemas.enums import WorkflowType

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/dashboard", summary="Org-wide overview (screen 17a)")
async def dashboard(user: AdminDep, session: SessionDep) -> dict[str, Any]:
    workflows = WorkflowRepository(session)
    approvals = ApprovalRepository(session)
    vendors = VendorRepository(session)
    pos = PurchaseOrderRepository(session)

    counts = await workflows.dashboard_counts(user.org_id)
    pending = await approvals.count_pending(user.org_id)
    flagged = await vendors.count_flagged(user.org_id)
    spend_rows = await pos.spend_by_vendor(user.org_id)
    total_spend = sum((r[3] or Decimal("0") for r in spend_rows), Decimal("0"))

    return {
        "stats": [
            {
                "key": "active_workflows",
                "label": "Active workflows",
                "value": str(counts["active"]),
                "numeric_value": counts["active"],
                "tone": "neutral",
            },
            {
                "key": "pending_approvals",
                "label": "Pending approvals",
                "value": str(pending),
                "numeric_value": pending,
                "tone": "warning" if pending else "neutral",
            },
            {
                "key": "completed",
                "label": "Completed this week",
                "value": str(counts["completed"]),
                "numeric_value": counts["completed"],
                "tone": "positive",
            },
            {
                "key": "flagged_vendors",
                "label": "Flagged vendors",
                "value": str(flagged),
                "numeric_value": flagged,
                "tone": "danger" if flagged else "neutral",
            },
        ],
        "pending_approvals": pending,
        "active_workflows": counts["active"],
        "completed_this_week": counts["completed"],
        "flagged_vendors": flagged,
        "total_spend": float(total_spend),
        "currency": "PKR",
        "generated_at": datetime.now(UTC).isoformat(),
    }


@router.get("/spend", summary="Spend report by vendor")
async def spend_report(
    user: AdminDep, session: SessionDep, days: int = Query(30, ge=1, le=365)
) -> dict[str, Any]:
    since = datetime.now(UTC) - timedelta(days=days)
    rows = await PurchaseOrderRepository(session).spend_by_vendor(user.org_id, since)
    vendors = VendorRepository(session)

    by_vendor = []
    total = Decimal("0")
    for vendor_id, _po_number, count, amount in rows:
        vendor = await vendors.get(vendor_id)
        amount = amount or Decimal("0")
        total += amount
        by_vendor.append(
            {
                "vendor_id": str(vendor_id),
                "vendor_name": vendor.name if vendor else "unknown",
                "order_count": count,
                "total_spend": float(amount),
                "on_time_rate": (
                    float(vendor.on_time_rate)
                    if vendor and vendor.on_time_rate is not None
                    else None
                ),
            }
        )

    by_vendor.sort(key=lambda r: r["total_spend"], reverse=True)
    return {
        "currency": "PKR",
        "period_start": since.isoformat(),
        "period_end": datetime.now(UTC).isoformat(),
        "total_spend": float(total),
        "order_count": sum(r["order_count"] for r in by_vendor),
        "by_vendor": by_vendor,
        "generated_at": datetime.now(UTC).isoformat(),
    }


# --------------------------------------------------------------------------
# Scoring weights
# --------------------------------------------------------------------------
@router.get("/scoring-weights", summary="Current scoring weights")
async def get_weights(user: BuyerDep, session: SessionDep) -> dict[str, Any]:
    weights, is_default = await ConfigRepository(session).weights_for(user.org_id)
    return {
        **weights.as_dict(),
        "label": weights.label,
        "is_default": is_default,
        "org_id": str(user.org_id) if user.org_id else None,
    }


@router.put("/scoring-weights", summary="Update scoring weights")
async def set_weights(
    body: ScoringWeights, user: AdminDep, session: SessionDep
) -> dict[str, Any]:
    """Takes effect on the next scored run -- no redeploy.

    The schema enforces that the weights sum to 1.0, and so does a CHECK
    constraint, so a partial update cannot leave scoring in an invalid state.
    """
    if user.org_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "your account is not linked to an organisation",
        )
    await ConfigRepository(session).set_weights(
        user.org_id, body, updated_by=user.id
    )
    return {**body.as_dict(), "label": body.label, "is_default": False}


# --------------------------------------------------------------------------
# Policy rules -- drive the reimbursement workflow
# --------------------------------------------------------------------------
@router.get("/policy-rules", summary="Expense policy rules")
async def list_policy_rules(
    user: BuyerDep,
    session: SessionDep,
    workflow_type: WorkflowType = Query(WorkflowType.REIMBURSEMENT),
) -> list[dict[str, Any]]:
    rows = await ConfigRepository(session).active_policy_rules(
        user.org_id, workflow_type
    )
    return [
        {
            "id": str(r.id),
            "name": r.name,
            "rule_type": r.rule_type,
            "workflow_type": r.workflow_type,
            "category": r.category,
            "numeric_value": float(r.numeric_value) if r.numeric_value else None,
            "currency": r.currency,
            "text_value": r.text_value,
            "message": r.message,
            "active": r.active,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@router.post(
    "/policy-rules",
    status_code=status.HTTP_201_CREATED,
    summary="Create a policy rule",
)
async def create_policy_rule(
    body: PolicyRuleCreate, user: AdminDep, session: SessionDep
) -> dict[str, Any]:
    from app.db.models import PolicyRule

    rule = PolicyRule(
        org_id=user.org_id,
        created_by=user.id,
        name=body.name,
        rule_type=body.rule_type.value,
        workflow_type=body.workflow_type.value,
        category=body.category,
        numeric_value=body.numeric_value,
        currency=body.currency,
        text_value=body.text_value,
        message=body.message,
        active=body.active,
    )
    session.add(rule)
    await session.flush()
    return {"id": str(rule.id), "name": rule.name, "active": rule.active}


@router.delete("/policy-rules/{rule_id}", summary="Delete a policy rule")
async def delete_policy_rule(
    rule_id: UUID, user: AdminDep, session: SessionDep
) -> dict[str, Any]:
    from app.db.models import PolicyRule

    rule = await session.get(PolicyRule, rule_id)
    if rule is None or (user.org_id and rule.org_id != user.org_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "policy rule not found")
    await session.delete(rule)
    return {"deleted": True, "id": str(rule_id)}


@router.get("/flagged-vendors", summary="Vendors auto-flagged by the monitor (18a)")
async def flagged_vendors(user: AdminDep, session: SessionDep) -> list[dict[str, Any]]:
    from sqlalchemy import select

    from app.db.models import Vendor, VendorFlagRow

    stmt = (
        select(VendorFlagRow, Vendor)
        .join(Vendor, Vendor.id == VendorFlagRow.vendor_id)
        .where(VendorFlagRow.resolved_at.is_(None))
    )
    if user.org_id:
        stmt = stmt.where(Vendor.org_id == user.org_id)

    rows = (await session.execute(stmt.order_by(VendorFlagRow.raised_at.desc()))).all()
    return [
        {
            "vendor_id": str(vendor.id),
            "vendor_name": vendor.name,
            "vendor_status": vendor.status,
            "reason": flag.reason,
            "detail": flag.detail,
            "threshold": flag.threshold,
            "raised_at": flag.raised_at.isoformat(),
        }
        for flag, vendor in rows
    ]
