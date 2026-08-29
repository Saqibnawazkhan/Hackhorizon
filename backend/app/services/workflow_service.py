"""Workflow orchestration service.

Owns the lifecycle the design implies:

    2a  POST /workflows            -> plan only. Nothing executes yet.
    3a  POST /workflows/{id}/run   -> user confirmed the plan; execute.
    8a  POST /approvals/{id}/decision -> resume the interrupted graph.

Planning is synchronous because screen 2a shows the extracted entities in the
same interaction; it is one Claude call and typically well under a second.
Execution is a background task, because it makes tool calls and the client
watches it over the WebSocket rather than holding a request open.
"""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

import structlog

from app.agent.orchestrator import graph as G
from app.agent.orchestrator.events import emit
from app.agent.orchestrator.template import for_workflow_type
from app.agent.planner.planner import Planner, PlannerError
from app.core.config import settings
from app.db.models import Workflow
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import session_scope
from app.repositories.procurement_repo import ApprovalRepository
from app.repositories.workflow_repo import StepRepository, WorkflowRepository
from app.schemas.auth import CurrentUser
from app.schemas.enums import (
    ApprovalDecision,
    WSEventType,
    WorkflowStatus,
    WorkflowType,
)
from app.schemas.planner import PlannerOutput

log = structlog.get_logger(__name__)


class WorkflowServiceError(RuntimeError):
    pass


def _title_for(output: PlannerOutput) -> str:
    """A short list-tile title.

    Procurement counts units ("Laptops - 50 units"); a reimbursement counts
    money, not units, so it reads "Travel claim - PKR 85,000" instead. Using
    the procurement wording for a claim made "4 units" appear on an expense
    report, which is meaningless there.
    """
    entities = output.entities
    items = entities.items
    if not items:
        return output.summary[:80]
    first = items[0]

    if entities.workflow_type is WorkflowType.REIMBURSEMENT:
        label = (
            first.name.title()
            if len(items) == 1
            else f"{first.name.title()} +{len(items) - 1} more"
        )
        if entities.budget:
            return f"{label} claim — {entities.currency} {entities.budget:,.0f}"
        return f"{label} claim"

    if len(items) == 1:
        return f"{first.name.title()} — {first.quantity} units"
    return (
        f"{first.name.title()} +{len(items) - 1} more — "
        f"{entities.total_quantity} units"
    )


async def plan_workflow(
    *, request_text: str, user: CurrentUser, idempotency_key: str | None = None
) -> tuple[Workflow, PlannerOutput, int]:
    """Run the planner and persist a DRAFT workflow with its plan.

    Nothing executes here. The user sees the extracted entities and the step
    plan first, and confirms on screen 3a.
    """
    async with session_scope() as session:
        repo = WorkflowRepository(session)

        if idempotency_key:
            existing = await repo.find_by_idempotency_key(user.id, idempotency_key)
            if existing is not None:
                output = PlannerOutput.model_validate(
                    {
                        "entities": existing.entities_json,
                        "steps": existing.plan_json,
                        "summary": existing.summary or "",
                    }
                )
                return existing, output, existing.planner_attempts

    try:
        result = await Planner().plan(request_text)
    except PlannerError as exc:
        raise WorkflowServiceError(
            f"Could not understand the request after {exc.attempts} attempts. "
            "Try rephrasing it with the items, quantities and budget."
        ) from exc

    output = result.output
    entities = output.entities
    template = for_workflow_type(entities.workflow_type)

    async with session_scope() as session:
        repo = WorkflowRepository(session)
        steps = StepRepository(session)

        workflow = await repo.create(
            org_id=user.org_id,
            requester_id=user.id,
            title=_title_for(output),
            request_text=request_text,
            workflow_type=entities.workflow_type.value,
            entities_json=entities.model_dump(mode="json"),
            plan_json=[s.model_dump(mode="json") for s in output.steps],
            summary=output.summary,
            status=WorkflowStatus.DRAFT.value,
            currency=entities.currency,
            budget=entities.budget,
            planner_attempts=result.attempt_count,
            idempotency_key=idempotency_key,
        )
        workflow.checkpoint_thread_id = f"workflow:{workflow.id}"

        await repo.add_items(
            workflow, [i.model_dump(mode="json") for i in entities.items]
        )
        # Persist the plan as pending steps so screen 3a and the live
        # execution screens read from one place.
        await steps.create_plan(
            workflow.id,
            [s.model_dump(mode="json") for s in output.steps],
            max_retries=template.tool_max_attempts(),
        )
        await session.refresh(workflow)
        return workflow, output, result.attempt_count


async def execute_workflow(workflow_id: UUID) -> dict[str, Any]:
    """Run the compiled graph until it finishes or hits the approval gate."""
    async with session_scope() as session:
        repo = WorkflowRepository(session)
        workflow = await repo.get_or_raise(workflow_id)
        entities = workflow.entities_json or {}
        state = G.build_initial_state(
            workflow_id=workflow.id,
            org_id=workflow.org_id,
            requester_id=workflow.requester_id,
            workflow_type=WorkflowType(workflow.workflow_type),
            request_text=workflow.request_text,
            currency=workflow.currency,
            budget=workflow.budget,
            items=entities.get("items", []),
            approver=entities.get("approver"),
        )
        # Load the plan once, here, instead of letting every node read its own
        # row by name on the way in and again on the way out.
        rows = await StepRepository(session).for_workflow(workflow.id)
        state["steps_meta"] = {
            s.name: {
                "id": str(s.id),
                "order": s.step_order,
                "title": s.title,
                "tool_name": s.tool_name,
            }
            for s in rows
        }
        await repo.set_status(workflow, WorkflowStatus.RUNNING)

    await emit(
        workflow_id,
        WSEventType.WORKFLOW_STATUS_CHANGED,
        {
            "status": WorkflowStatus.RUNNING.value,
            "previous_status": WorkflowStatus.DRAFT.value,
            "progress_percent": 0,
        },
    )

    template = for_workflow_type(WorkflowType(state["workflow_type"]))
    checkpointer, manager = await G.get_checkpointer()
    try:
        compiled = await G.compile_graph(template, checkpointer=checkpointer)
        result = await compiled.ainvoke(
            state, config=G.thread_config(workflow_id)
        )
    except Exception as exc:  # noqa: BLE001 - a run must never take the API down
        log.exception("workflow.failed", workflow_id=str(workflow_id))
        async with session_scope() as session:
            repo = WorkflowRepository(session)
            workflow = await repo.get_or_raise(workflow_id)
            await repo.set_status(
                workflow, WorkflowStatus.FAILED, reason=str(exc)
            )
        await emit(
            workflow_id,
            WSEventType.WORKFLOW_ESCALATED,
            {"reason": str(exc), "stage": "engine", "detail": None},
        )
        return {"status": WorkflowStatus.FAILED.value, "error": str(exc)}
    finally:
        if manager is not None:
            await manager.__aexit__(None, None, None)

    interrupted = "__interrupt__" in result
    log.info(
        "workflow.paused" if interrupted else "workflow.finished",
        workflow_id=str(workflow_id),
        status=result.get("status"),
    )
    return {
        "status": result.get("status"),
        "awaiting_approval": interrupted,
        "selected_vendor": result.get("selected_vendor_name"),
        "justification": result.get("justification"),
        "escalated": result.get("escalated", False),
    }


def launch(workflow_id: UUID) -> asyncio.Task:
    """Fire-and-forget execution; the client watches over the WebSocket."""
    task = asyncio.create_task(execute_workflow(workflow_id))

    def _log_result(t: asyncio.Task) -> None:
        if t.cancelled():
            log.warning("workflow.cancelled", workflow_id=str(workflow_id))
        elif exc := t.exception():
            log.error(
                "workflow.task_error", workflow_id=str(workflow_id), error=str(exc)
            )

    task.add_done_callback(_log_result)
    return task


async def resume_after_decision(
    *, workflow_id: UUID, decision: ApprovalDecision, comment: str | None
) -> dict[str, Any]:
    """Resume the graph suspended at route_approval's ``interrupt()``.

    This is the ONLY way a workflow leaves AWAITING_APPROVAL, and the caller
    has already been checked to be an admin.
    """
    template_name = None
    async with session_scope() as session:
        workflow = await WorkflowRepository(session).get_or_raise(workflow_id)
        template_name = workflow.workflow_type

    template = for_workflow_type(WorkflowType(template_name))
    checkpointer, manager = await G.get_checkpointer()
    try:
        compiled = await G.compile_graph(template, checkpointer=checkpointer)
        result = await compiled.ainvoke(
            G.resume_command(decision.value, comment),
            config=G.thread_config(workflow_id),
        )
    finally:
        if manager is not None:
            await manager.__aexit__(None, None, None)

    return {
        "status": result.get("status"),
        "decision": result.get("approval_decision"),
    }


async def build_completion_report(workflow_id: UUID) -> dict[str, Any]:
    """Screen 9a. Assembled from the execution trace, never re-derived."""
    from app.repositories.procurement_repo import (
        PurchaseOrderRepository,
        QuoteRepository,
    )
    from app.repositories.workflow_repo import ToolCallRepository

    async with session_scope() as session:
        workflow = await WorkflowRepository(session).get_or_raise(workflow_id)
        steps = await StepRepository(session).for_workflow(workflow_id)
        calls = await ToolCallRepository(session).for_workflow(workflow_id)
        quotes = await QuoteRepository(session).for_workflow(workflow_id)
        po = await PurchaseOrderRepository(session).for_workflow(workflow_id)

        selected = next((q for q in quotes if q.status == "selected"), None)
        retries = sum(s.retry_count for s in steps)

        metrics = [
            {"label": "Status", "value": workflow.status, "emphasis": True},
            {"label": "Suppliers compared", "value": str(len(quotes))},
            {"label": "Steps executed", "value": str(len(steps))},
            {"label": "Tool calls", "value": str(len(calls))},
        ]
        if po is not None:
            metrics.insert(
                1,
                {
                    "label": "Order total",
                    "value": f"{po.currency} {po.total_amount:,.0f}",
                    "emphasis": True,
                },
            )
        if workflow.duration_ms:
            metrics.append(
                {
                    "label": "Duration",
                    "value": f"{workflow.duration_ms / 1000:.1f}s",
                }
            )

        sections = [
            {
                "heading": "What was requested",
                "body": workflow.request_text,
                "bullets": [],
            },
            {
                "heading": "What the agent did",
                "body": (
                    f"Executed {len(steps)} steps and {len(calls)} tool calls, "
                    f"comparing {len(quotes)} supplier(s)."
                ),
                "bullets": [
                    f"{s.title} — {s.status}"
                    + (f" ({s.duration_ms}ms)" if s.duration_ms else "")
                    for s in steps
                ],
            },
        ]
        if selected is not None:
            sections.append(
                {
                    "heading": "Decision",
                    "body": (
                        f"Selected {selected.vendor_name} at "
                        f"{selected.currency} {selected.total_amount:,.0f}."
                    ),
                    "bullets": [
                        f"{q.vendor_name}: "
                        + (
                            f"score {q.score_total}"
                            if q.score_total is not None
                            else (q.exclusion_reason or "not scored")
                        )
                        for q in quotes
                    ],
                }
            )

        return {
            "workflow_id": str(workflow_id),
            "title": workflow.title,
            "headline": (
                f"{workflow.title} — {workflow.status}"
                if not selected
                else f"{workflow.title} routed to {selected.vendor_name}"
            ),
            "metrics": metrics,
            "sections": sections,
            "decisions": [
                s.output_json.get("summary", "")
                for s in steps
                if s.output_json and s.output_json.get("summary")
            ],
            "caveats": [],
            "total_duration_ms": workflow.duration_ms,
            "steps_executed": len(steps),
            "tools_invoked": len(calls),
            "retries_performed": retries,
            "generated_at": datetime.now(UTC).isoformat(),
        }


async def build_audit_trail(
    workflow_id: UUID,
    *,
    session: AsyncSession | None = None,
    workflow: Workflow | None = None,
) -> list[dict[str, Any]]:
    """Screen 10b. A union over steps, tool calls and approvals.

    Assembled as a view rather than a duplicate table, so the trail can never
    disagree with what actually executed.

    ``session`` and ``workflow`` let a caller that has already loaded both hand
    them in. The endpoint checks visibility first, which loads the workflow --
    re-reading it here was a second round trip for a row already in memory.
    """
    from app.repositories.workflow_repo import ToolCallRepository

    if session is not None:
        return await _audit_rows(session, workflow_id, workflow)
    async with session_scope() as owned:
        return await _audit_rows(owned, workflow_id, workflow)


async def _audit_rows(
    session: AsyncSession,
    workflow_id: UUID,
    workflow: Workflow | None = None,
) -> list[dict[str, Any]]:
    from app.repositories.workflow_repo import ToolCallRepository

    workflow = workflow or await WorkflowRepository(session).get_or_raise(
        workflow_id
    )
    steps = await StepRepository(session).for_workflow(workflow_id)
    calls = await ToolCallRepository(session).for_workflow(workflow_id)
    approvals = await ApprovalRepository(session).open_for_workflow(workflow_id)

    events: list[dict[str, Any]] = [
        {
            "at": workflow.created_at.isoformat(),
            "source": "system",
            "actor": "requester",
            "event": "Workflow created",
            "detail": workflow.request_text[:200],
            "status": WorkflowStatus.DRAFT.value,
            "duration_ms": None,
            "reference_id": str(workflow.id),
        }
    ]
    for s in steps:
        if s.started_at:
            events.append(
                {
                    "at": s.started_at.isoformat(),
                    "source": "step",
                    "actor": "agent",
                    "event": s.title,
                    "detail": s.description,
                    "status": s.status,
                    "duration_ms": s.duration_ms,
                    "reference_id": str(s.id),
                }
            )
    for c in calls:
        events.append(
            {
                "at": c.started_at.isoformat(),
                "source": "tool_call",
                "actor": "agent",
                "event": f"Tool: {c.tool_name}",
                "detail": c.error or "ok",
                "status": c.status,
                "duration_ms": c.duration_ms,
                "reference_id": str(c.id),
            }
        )
    if approvals is not None:
        events.append(
            {
                "at": approvals.requested_at.isoformat(),
                "source": "approval",
                "actor": "agent",
                "event": "Routed for human approval",
                "detail": None,
                "status": approvals.decision,
                "duration_ms": None,
                "reference_id": str(approvals.id),
            }
        )

    events.sort(key=lambda e: e["at"])
    return events
