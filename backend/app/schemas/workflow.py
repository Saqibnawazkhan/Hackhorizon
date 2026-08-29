"""Workflow, step and tool-call schemas.

Covers design screens 1a (recent list), 3a (plan stepper), 4a/4b (live
execution + retry), 9a (completion report), 10a (history), 10b (audit trail).
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from pydantic import Field, computed_field

from app.schemas.common import AppModel, Identified
from app.schemas.enums import (
    StepStatus,
    ToolCallStatus,
    WorkflowStatus,
    WorkflowType,
)
from app.schemas.planner import PlannedStep, PlannerEntities


# --------------------------------------------------------------------------
# Requests
# --------------------------------------------------------------------------
class CreateWorkflowRequest(AppModel):
    """Free text only.

    There is deliberately no ``workflow_type`` field: the planner must infer it
    from the text. Accepting a client hint would defeat the generalizability
    proof, so the API refuses to take one.
    """

    request_text: str = Field(..., min_length=8, max_length=4000)
    idempotency_key: str | None = Field(
        None, max_length=100, description="Optional client-supplied dedupe key."
    )


class ConfirmPlanRequest(AppModel):
    """User confirmed the plan on screen 3a; begin execution."""

    confirmed: bool = True
    entity_overrides: PlannerEntities | None = Field(
        None,
        description="Populated when the user edited an extracted entity on 2a.",
    )


# --------------------------------------------------------------------------
# Tool calls
# --------------------------------------------------------------------------
class ToolCallRead(Identified):
    """Every tool invocation is logged, successes and failures alike."""

    step_id: UUID
    workflow_id: UUID
    tool_name: str
    status: ToolCallStatus
    attempt: int = Field(..., ge=1)
    retry_count: int = Field(0, ge=0)
    duration_ms: int = Field(..., ge=0)
    started_at: datetime
    completed_at: datetime | None
    input_json: dict[str, Any] | None
    output_json: dict[str, Any] | None
    error: str | None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def log_line(self) -> str:
        """Renders the expanded tool log on screen 4a."""
        return f"{self.tool_name} · {self.duration_ms}ms · {self.status.value}"


# --------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------
class StepRead(Identified):
    workflow_id: UUID
    step_order: int = Field(..., ge=1)
    name: str
    title: str
    description: str | None
    tool_name: str | None
    status: StepStatus
    retry_count: int = Field(0, ge=0)
    max_retries: int = Field(..., ge=0)
    started_at: datetime | None
    completed_at: datetime | None
    duration_ms: int | None
    error: str | None
    input_json: dict[str, Any] | None
    output_json: dict[str, Any] | None
    tool_calls: list[ToolCallRead] = Field(default_factory=list)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_retrying(self) -> bool:
        """Drives the 4b 'auto-retry' visual state."""
        return self.status is StepStatus.RETRYING


# --------------------------------------------------------------------------
# Workflows
# --------------------------------------------------------------------------
class WorkflowSummary(Identified):
    """List-tile shape for screens 1a and 10a."""

    title: str = Field(..., description="e.g. 'Laptop procurement — 50 units'.")
    workflow_type: WorkflowType
    status: WorkflowStatus
    currency: str
    total_amount: Decimal | None
    created_at: datetime
    completed_at: datetime | None
    duration_ms: int | None
    requester_id: UUID
    requester_name: str | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def status_label(self) -> str:
        """Exact pill copy used in the design."""
        return {
            WorkflowStatus.DRAFT: "Draft",
            WorkflowStatus.RUNNING: "In Progress",
            WorkflowStatus.AWAITING_APPROVAL: "Pending Approval",
            WorkflowStatus.APPROVED: "Approved",
            WorkflowStatus.REJECTED: "Rejected",
            WorkflowStatus.COMPLETED: "Done",
            WorkflowStatus.FAILED: "Failed",
            WorkflowStatus.ESCALATED: "Needs Attention",
        }[self.status]


class WorkflowDetail(WorkflowSummary):
    """Full record: plan, live steps, entities, and the current stage."""

    request_text: str
    entities: PlannerEntities | None
    plan: list[PlannedStep] = Field(default_factory=list)
    steps: list[StepRead] = Field(default_factory=list)
    current_step_order: int | None
    self_correction_attempts: int = Field(0, ge=0)
    max_self_correction_attempts: int = Field(..., ge=0)
    escalation_reason: str | None
    purchase_order_id: UUID | None
    approval_id: UUID | None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def progress_percent(self) -> int:
        if not self.steps:
            return 0
        done = sum(
            1 for s in self.steps if s.status is StepStatus.COMPLETED
        )
        return int(round(done / len(self.steps) * 100))


class WorkflowPlanResponse(AppModel):
    """Returned by the planning call -- screen 2a -> 3a handshake."""

    workflow_id: UUID
    status: WorkflowStatus
    summary: str
    entities: PlannerEntities
    plan: list[PlannedStep]
    planner_attempts: int = Field(..., ge=1)


class WorkflowFilters(AppModel):
    """Mirrors the filter chips on screen 10a."""

    status: WorkflowStatus | None = None
    workflow_type: WorkflowType | None = None
    requester_id: UUID | None = None
    created_after: datetime | None = None
    created_before: datetime | None = None
    search: str | None = Field(None, max_length=200)


# --------------------------------------------------------------------------
# Completion report -- screen 9a
# --------------------------------------------------------------------------
class ReportMetric(AppModel):
    label: str
    value: str
    emphasis: bool = False


class ReportSection(AppModel):
    heading: str
    body: str
    bullets: list[str] = Field(default_factory=list)


class CompletionReport(AppModel):
    workflow_id: UUID
    title: str
    headline: str = Field(..., description="Plain-language outcome, one sentence.")
    metrics: list[ReportMetric]
    sections: list[ReportSection]
    decisions: list[str] = Field(
        ..., description="Every autonomous decision with its justification."
    )
    caveats: list[str] = Field(default_factory=list)
    total_duration_ms: int | None
    steps_executed: int
    tools_invoked: int
    retries_performed: int
    generated_at: datetime


# --------------------------------------------------------------------------
# Audit trail -- screen 10b
# --------------------------------------------------------------------------
class AuditEvent(AppModel):
    """One timestamped row on the audit timeline.

    Assembled as a union over steps, tool_calls and approvals rather than a
    duplicate table, so the trail can never disagree with execution history.
    """

    at: datetime
    source: str = Field(..., description="step | tool_call | approval | system")
    actor: str = Field(..., description="'agent', or a user's display name.")
    event: str
    detail: str | None = None
    status: str | None = None
    duration_ms: int | None = None
    reference_id: UUID | None = None
