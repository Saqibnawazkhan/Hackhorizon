"""WebSocket event contract.

Every frame is a ``WSEvent`` envelope with a monotonically increasing ``seq``
scoped to the workflow. A client joining mid-run sends ``last_seq`` and gets
the buffered tail replayed before live frames resume, so screens 4a/4b can be
reconstructed exactly regardless of when the phone connected.

Every event also has a REST equivalent (``GET /workflows/{id}`` returns the
same state) so the app degrades gracefully when the socket is unavailable.
"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, Union
from uuid import UUID

from pydantic import Field

from app.schemas.common import AppModel
from app.schemas.enums import StepStatus, WSEventType, WorkflowStatus


class WSEnvelope(AppModel):
    """Common frame header."""

    type: WSEventType
    workflow_id: UUID
    seq: int = Field(..., ge=0, description="Per-workflow monotonic sequence number.")
    ts: datetime


class StepStartedPayload(AppModel):
    step_id: UUID
    step_order: int
    name: str
    title: str
    tool_name: str | None = None


class StepCompletedPayload(AppModel):
    step_id: UUID
    step_order: int
    name: str
    duration_ms: int
    output_summary: str | None = None


class StepFailedPayload(AppModel):
    step_id: UUID
    step_order: int
    name: str
    error: str
    will_retry: bool
    retry_count: int
    max_retries: int


class StepRetryingPayload(AppModel):
    """Drives the 4b auto-retry visual state."""

    step_id: UUID
    step_order: int
    name: str
    attempt: int
    max_attempts: int
    delay_seconds: float
    reason: str


class ToolCalledPayload(AppModel):
    tool_call_id: UUID
    step_id: UUID
    tool_name: str
    status: str
    duration_ms: int
    retry_count: int
    summary: str | None = None


class WorkflowStatusPayload(AppModel):
    status: WorkflowStatus
    previous_status: WorkflowStatus | None = None
    progress_percent: int = Field(..., ge=0, le=100)


class ComparisonReadyPayload(AppModel):
    strategy: str
    selected_vendor_name: str | None
    justification: str
    quote_count: int


class ValidationResultPayload(AppModel):
    passed: bool
    attempt: int
    max_attempts: int
    passed_count: int
    total_checks: int
    failed_check_titles: list[str] = Field(default_factory=list)


class SelfCorrectionPayload(AppModel):
    """Backward edge validate_po -> generate_po fired."""

    attempt: int
    max_attempts: int
    reason: str


class ApprovalRequiredPayload(AppModel):
    approval_id: UUID
    purchase_order_id: UUID | None
    total_amount: float | None
    currency: str
    vendor_name: str | None


class WorkflowCompletedPayload(AppModel):
    status: WorkflowStatus
    duration_ms: int | None
    report_available: bool = True


class WorkflowEscalatedPayload(AppModel):
    reason: str
    stage: str = Field(..., description="budget_filter | validate_po | tool_failure")
    detail: str | None = None


class HeartbeatPayload(AppModel):
    server_time: datetime


# --------------------------------------------------------------------------
# Discriminated union
# --------------------------------------------------------------------------
class _Event(WSEnvelope):
    pass


class StepStartedEvent(_Event):
    type: Literal[WSEventType.STEP_STARTED] = WSEventType.STEP_STARTED
    payload: StepStartedPayload


class StepCompletedEvent(_Event):
    type: Literal[WSEventType.STEP_COMPLETED] = WSEventType.STEP_COMPLETED
    payload: StepCompletedPayload


class StepFailedEvent(_Event):
    type: Literal[WSEventType.STEP_FAILED] = WSEventType.STEP_FAILED
    payload: StepFailedPayload


class StepRetryingEvent(_Event):
    type: Literal[WSEventType.STEP_RETRYING] = WSEventType.STEP_RETRYING
    payload: StepRetryingPayload


class ToolCalledEvent(_Event):
    type: Literal[WSEventType.TOOL_CALLED] = WSEventType.TOOL_CALLED
    payload: ToolCalledPayload


class WorkflowStatusChangedEvent(_Event):
    type: Literal[WSEventType.WORKFLOW_STATUS_CHANGED] = (
        WSEventType.WORKFLOW_STATUS_CHANGED
    )
    payload: WorkflowStatusPayload


class ComparisonReadyEvent(_Event):
    type: Literal[WSEventType.COMPARISON_READY] = WSEventType.COMPARISON_READY
    payload: ComparisonReadyPayload


class ValidationResultEvent(_Event):
    type: Literal[WSEventType.VALIDATION_RESULT] = WSEventType.VALIDATION_RESULT
    payload: ValidationResultPayload


class SelfCorrectionStartedEvent(_Event):
    type: Literal[WSEventType.SELF_CORRECTION_STARTED] = (
        WSEventType.SELF_CORRECTION_STARTED
    )
    payload: SelfCorrectionPayload


class ApprovalRequiredEvent(_Event):
    type: Literal[WSEventType.APPROVAL_REQUIRED] = WSEventType.APPROVAL_REQUIRED
    payload: ApprovalRequiredPayload


class WorkflowCompletedEvent(_Event):
    type: Literal[WSEventType.WORKFLOW_COMPLETED] = WSEventType.WORKFLOW_COMPLETED
    payload: WorkflowCompletedPayload


class WorkflowEscalatedEvent(_Event):
    type: Literal[WSEventType.WORKFLOW_ESCALATED] = WSEventType.WORKFLOW_ESCALATED
    payload: WorkflowEscalatedPayload


class HeartbeatEvent(_Event):
    type: Literal[WSEventType.HEARTBEAT] = WSEventType.HEARTBEAT
    payload: HeartbeatPayload


WSEvent = Annotated[
    Union[
        StepStartedEvent,
        StepCompletedEvent,
        StepFailedEvent,
        StepRetryingEvent,
        ToolCalledEvent,
        WorkflowStatusChangedEvent,
        ComparisonReadyEvent,
        ValidationResultEvent,
        SelfCorrectionStartedEvent,
        ApprovalRequiredEvent,
        WorkflowCompletedEvent,
        WorkflowEscalatedEvent,
        HeartbeatEvent,
    ],
    Field(discriminator="type"),
]


class WSSubscribeMessage(AppModel):
    """First frame the client sends after connecting."""

    action: Literal["subscribe"] = "subscribe"
    workflow_id: UUID
    last_seq: int = Field(
        0,
        ge=0,
        description=(
            "Highest event cursor already rendered. The server sends "
            "everything after it. Send 0 for a full catch-up."
        ),
    )


class WSErrorMessage(AppModel):
    action: Literal["error"] = "error"
    error: str
    message: str


def build_step_status_from(status: StepStatus) -> WSEventType:
    """Map a step status transition onto its event type."""
    return {
        StepStatus.RUNNING: WSEventType.STEP_STARTED,
        StepStatus.COMPLETED: WSEventType.STEP_COMPLETED,
        StepStatus.FAILED: WSEventType.STEP_FAILED,
        StepStatus.RETRYING: WSEventType.STEP_RETRYING,
    }.get(status, WSEventType.WORKFLOW_STATUS_CHANGED)


__all__ = [
    "WSEvent",
    "WSEnvelope",
    "WSSubscribeMessage",
    "WSErrorMessage",
    "StepStartedEvent",
    "StepCompletedEvent",
    "StepFailedEvent",
    "StepRetryingEvent",
    "ToolCalledEvent",
    "WorkflowStatusChangedEvent",
    "ComparisonReadyEvent",
    "ValidationResultEvent",
    "SelfCorrectionStartedEvent",
    "ApprovalRequiredEvent",
    "WorkflowCompletedEvent",
    "WorkflowEscalatedEvent",
    "HeartbeatEvent",
    "StepStartedPayload",
    "StepCompletedPayload",
    "StepFailedPayload",
    "StepRetryingPayload",
    "ToolCalledPayload",
    "WorkflowStatusPayload",
    "ComparisonReadyPayload",
    "ValidationResultPayload",
    "SelfCorrectionPayload",
    "ApprovalRequiredPayload",
    "WorkflowCompletedPayload",
    "WorkflowEscalatedPayload",
    "HeartbeatPayload",
    "build_step_status_from",
]
