"""Approvals, admin configuration and reporting.

Design screens: 8a (approver view), 8b (approved confirmation), 12a (full PO
detail review), 17a (admin dashboard), 18a (vendor management).

THE AGENT NEVER AUTO-APPROVES. The only transition into APPROVED is
``POST /approvals/{id}/decision`` carrying an authenticated admin identity.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import Field, computed_field, model_validator

from app.schemas.common import AppModel, Identified
from app.schemas.enums import ApprovalDecision, PolicyRuleType, WorkflowType


# --------------------------------------------------------------------------
# Approvals
# --------------------------------------------------------------------------
class ApprovalRead(Identified):
    workflow_id: UUID
    purchase_order_id: UUID | None
    decision: ApprovalDecision
    requested_at: datetime
    decided_at: datetime | None
    decided_by: UUID | None
    decided_by_name: str | None
    approver_role: str
    comment: str | None

    # Denormalised for the queue list on 8a / 17a.
    title: str
    vendor_name: str | None
    total_amount: Decimal | None
    currency: str
    requester_name: str | None
    budget: Decimal | None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_pending(self) -> bool:
        return self.decision is ApprovalDecision.PENDING

    @computed_field  # type: ignore[prop-decorator]
    @property
    def budget_utilisation_percent(self) -> int | None:
        """'94% of budget' -- shown in the justification on 11a and on 12a."""
        if self.budget is None or not self.budget or self.total_amount is None:
            return None
        return int(round(float(self.total_amount) / float(self.budget) * 100))


class ApprovalDecisionRequest(AppModel):
    """Resumes the LangGraph ``interrupt()`` at route_approval."""

    decision: ApprovalDecision
    comment: str | None = Field(None, max_length=1000)
    idempotency_key: str | None = Field(
        None,
        max_length=100,
        description="Guards against a double-tap on Approve resuming twice.",
    )

    @model_validator(mode="after")
    def _decision_is_terminal(self) -> ApprovalDecisionRequest:
        if self.decision is ApprovalDecision.PENDING:
            raise ValueError("decision must be 'approved' or 'rejected'")
        return self


class ApprovalDecisionResponse(AppModel):
    approval: ApprovalRead
    workflow_status: str
    resumed: bool = Field(
        ..., description="False when the decision was a replayed idempotent call."
    )


# --------------------------------------------------------------------------
# Scoring configuration
# --------------------------------------------------------------------------
class ScoringWeights(AppModel):
    price: float = Field(..., ge=0.0, le=1.0)
    delivery: float = Field(..., ge=0.0, le=1.0)
    warranty: float = Field(..., ge=0.0, le=1.0)
    reliability: float = Field(0.0, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _sums_to_one(self) -> ScoringWeights:
        total = self.price + self.delivery + self.warranty + self.reliability
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"weights must sum to 1.0; got {total:.4f}")
        return self

    @computed_field  # type: ignore[prop-decorator]
    @property
    def label(self) -> str:
        """'Price 50% · Delivery 30% · Warranty 20%' (design 5a)."""
        parts = [
            ("Price", self.price),
            ("Delivery", self.delivery),
            ("Warranty", self.warranty),
            ("Reliability", self.reliability),
        ]
        return " · ".join(
            f"{n} {round(v * 100)}%" for n, v in parts if v > 0
        )

    def as_dict(self) -> dict[str, float]:
        return {
            "price": self.price,
            "delivery": self.delivery,
            "warranty": self.warranty,
            "reliability": self.reliability,
        }


class ScoringWeightsRead(ScoringWeights):
    org_id: UUID | None
    updated_at: datetime | None
    updated_by: UUID | None
    is_default: bool = Field(
        ..., description="True when falling back to the env-configured values."
    )


# --------------------------------------------------------------------------
# Policy rules -- drive the reimbursement workflow
# --------------------------------------------------------------------------
class PolicyRuleBase(AppModel):
    name: str = Field(..., min_length=1, max_length=140)
    rule_type: PolicyRuleType
    workflow_type: WorkflowType = WorkflowType.REIMBURSEMENT
    category: str | None = Field(
        None, max_length=100, description="e.g. 'travel', 'meals'. None = all."
    )
    numeric_value: Decimal | None = Field(None, ge=0)
    currency: str | None = Field(None, min_length=3, max_length=3)
    text_value: str | None = Field(None, max_length=500)
    active: bool = True
    message: str = Field(
        ...,
        max_length=300,
        description="Shown verbatim on the policy-check results screen.",
    )


class PolicyRuleCreate(PolicyRuleBase):
    pass


class PolicyRuleRead(PolicyRuleBase, Identified):
    org_id: UUID | None
    created_at: datetime


# --------------------------------------------------------------------------
# Dashboard + reports -- screen 17a
# --------------------------------------------------------------------------
class DashboardStat(AppModel):
    key: str
    label: str
    value: str
    numeric_value: float | None = None
    tone: str = Field("neutral", description="neutral | positive | warning | danger")


class AdminDashboard(AppModel):
    stats: list[DashboardStat]
    pending_approvals: int = Field(..., ge=0)
    active_workflows: int = Field(..., ge=0)
    completed_this_week: int = Field(..., ge=0)
    flagged_vendors: int = Field(..., ge=0)
    total_spend: Decimal
    currency: str
    recent_workflows: list[dict] = Field(default_factory=list)
    generated_at: datetime


class SpendByVendor(AppModel):
    vendor_id: UUID
    vendor_name: str
    order_count: int = Field(..., ge=0)
    total_spend: Decimal
    on_time_rate: float | None = None


class SpendReport(AppModel):
    currency: str
    period_start: datetime
    period_end: datetime
    total_spend: Decimal
    order_count: int = Field(..., ge=0)
    by_vendor: list[SpendByVendor]
    by_category: list[dict] = Field(default_factory=list)
    generated_at: datetime
