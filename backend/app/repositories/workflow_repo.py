"""Workflow, step, tool-call and event repositories.

Everything the live-execution screens and the audit trail read comes from
here. Steps and tool calls are written as they happen, so the trace is
complete even if the process dies mid-run.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Sequence
from uuid import UUID

from sqlalchemy import Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import selectinload

from app.db.models import (
    Step,
    ToolCall,
    Workflow,
    WorkflowEvent,
    WorkflowItem,
)
from app.repositories.base import BaseRepository
from app.schemas.enums import StepStatus, ToolCallStatus, WorkflowStatus, WorkflowType


class WorkflowRepository(BaseRepository[Workflow]):
    model = Workflow

    def _visible_to(
        self, *, requester_id: UUID | None, org_id: UUID | None, is_admin: bool
    ) -> Select:
        """Mirrors the RLS predicate so service-role queries stay scoped.

        The backend connects as service_role and bypasses RLS, so this method
        is what actually enforces "employees see only their own workflows".
        """
        stmt = select(Workflow)
        if is_admin:
            return stmt.where(Workflow.org_id == org_id) if org_id else stmt
        return stmt.where(Workflow.requester_id == requester_id)

    async def list_visible(
        self,
        *,
        requester_id: UUID | None,
        org_id: UUID | None,
        is_admin: bool,
        status: WorkflowStatus | None = None,
        workflow_type: WorkflowType | None = None,
        search: str | None = None,
        created_after: datetime | None = None,
        created_before: datetime | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[Sequence[Workflow], int]:
        stmt = self._visible_to(
            requester_id=requester_id, org_id=org_id, is_admin=is_admin
        )
        if status is not None:
            stmt = stmt.where(Workflow.status == status.value)
        if workflow_type is not None:
            stmt = stmt.where(Workflow.workflow_type == workflow_type.value)
        if search:
            stmt = stmt.where(Workflow.title.ilike(f"%{search}%"))
        if created_after is not None:
            stmt = stmt.where(Workflow.created_at >= created_after)
        if created_before is not None:
            stmt = stmt.where(Workflow.created_at <= created_before)
        stmt = stmt.order_by(Workflow.created_at.desc())
        return await self.paginate(stmt, limit=limit, offset=offset)

    async def get_visible(
        self,
        workflow_id: UUID,
        *,
        requester_id: UUID | None,
        org_id: UUID | None,
        is_admin: bool,
    ) -> Workflow | None:
        stmt = self._visible_to(
            requester_id=requester_id, org_id=org_id, is_admin=is_admin
        ).where(Workflow.id == workflow_id)
        return await self.session.scalar(stmt)

    async def find_by_idempotency_key(
        self, requester_id: UUID, key: str
    ) -> Workflow | None:
        return await self.session.scalar(
            select(Workflow).where(
                Workflow.requester_id == requester_id,
                Workflow.idempotency_key == key,
            )
        )

    async def set_status(
        self, workflow: Workflow, status: WorkflowStatus, *, reason: str | None = None
    ) -> Workflow:
        workflow.status = status.value
        if reason:
            workflow.escalation_reason = reason
        if status is WorkflowStatus.RUNNING and workflow.started_at is None:
            workflow.started_at = datetime.now(UTC)
        if status.is_terminal and workflow.completed_at is None:
            workflow.completed_at = datetime.now(UTC)
            start = workflow.started_at or workflow.created_at
            if start is not None:
                workflow.duration_ms = int(
                    (workflow.completed_at - start).total_seconds() * 1000
                )
        await self.session.flush()
        return workflow

    async def add_items(
        self, workflow: Workflow, items: Sequence[dict[str, Any]]
    ) -> Sequence[WorkflowItem]:
        rows = [
            WorkflowItem(
                workflow_id=workflow.id,
                position=i,
                name=item["name"],
                quantity=item["quantity"],
                unit=item.get("unit"),
                specification=item.get("specification"),
                category_hint=item.get("category_hint"),
            )
            for i, item in enumerate(items, start=1)
        ]
        self.session.add_all(rows)
        await self.session.flush()
        return rows

    async def dashboard_counts(self, org_id: UUID | None) -> dict[str, int]:
        """The three hero figures on 1a and 17a, in one round trip.

        They were three COUNT statements over the same table, which is three
        sequential round trips on a link where a round trip is the entire
        cost. FILTER computes all three in a single pass.
        """
        stmt = select(
            func.count()
            .filter(
                Workflow.status.in_(
                    [WorkflowStatus.RUNNING.value, WorkflowStatus.DRAFT.value]
                )
            )
            .label("active"),
            func.count()
            .filter(Workflow.status == WorkflowStatus.AWAITING_APPROVAL.value)
            .label("pending"),
            func.count()
            .filter(Workflow.status == WorkflowStatus.COMPLETED.value)
            .label("completed"),
        ).select_from(Workflow)
        if org_id:
            stmt = stmt.where(Workflow.org_id == org_id)

        row = (await self.session.execute(stmt)).one()
        return {
            "active": int(row.active or 0),
            "pending_approval": int(row.pending or 0),
            "completed": int(row.completed or 0),
        }


class StepRepository(BaseRepository[Step]):
    model = Step

    async def create_plan(
        self, workflow_id: UUID, plan: Sequence[dict[str, Any]], *, max_retries: int
    ) -> Sequence[Step]:
        rows = [
            Step(
                workflow_id=workflow_id,
                step_order=s["order"],
                name=s["name"],
                title=s["title"],
                description=s.get("description"),
                tool_name=s.get("tool_name"),
                status=StepStatus.PENDING.value,
                max_retries=max_retries,
            )
            for s in plan
        ]
        self.session.add_all(rows)
        await self.session.flush()
        return rows

    async def for_workflow(
        self, workflow_id: UUID, *, with_tool_calls: bool = False
    ) -> Sequence[Step]:
        """Steps in order.

        ``tool_calls`` is lazy="raise", so the one caller that renders the tool
        log asks for it here. Everything else -- the orchestrator especially --
        avoids the extra query per step.
        """
        stmt = (
            select(Step)
            .where(Step.workflow_id == workflow_id)
            .order_by(Step.step_order)
        )
        if with_tool_calls:
            stmt = stmt.options(selectinload(Step.tool_calls))
        return (await self.session.scalars(stmt)).all()

    async def by_name(self, workflow_id: UUID, name: str) -> Step | None:
        return await self.session.scalar(
            select(Step).where(Step.workflow_id == workflow_id, Step.name == name)
        )

    async def start(self, step: Step) -> Step:
        step.status = StepStatus.RUNNING.value
        step.started_at = datetime.now(UTC)
        step.error = None
        await self.session.flush()
        return step

    async def complete(
        self, step: Step, output: dict[str, Any] | None = None
    ) -> Step:
        step.status = StepStatus.COMPLETED.value
        step.completed_at = datetime.now(UTC)
        step.output_json = output
        if step.started_at:
            step.duration_ms = int(
                (step.completed_at - step.started_at).total_seconds() * 1000
            )
        await self.session.flush()
        return step

    async def fail(self, step: Step, error: str) -> Step:
        step.status = StepStatus.FAILED.value
        step.completed_at = datetime.now(UTC)
        step.error = error
        if step.started_at:
            step.duration_ms = int(
                (step.completed_at - step.started_at).total_seconds() * 1000
            )
        await self.session.flush()
        return step

    async def mark_retrying(self, step: Step, retry_count: int) -> Step:
        """Design screen 4b. Capped so the DB CHECK can never be violated."""
        step.status = StepStatus.RETRYING.value
        step.retry_count = min(retry_count, step.max_retries)
        await self.session.flush()
        return step

    async def reset_for_retry(self, step: Step) -> Step:
        """Used by the validate_po -> generate_po backward edge."""
        step.status = StepStatus.PENDING.value
        step.error = None
        step.output_json = None
        step.started_at = None
        step.completed_at = None
        step.duration_ms = None
        await self.session.flush()
        return step


class ToolCallRepository(BaseRepository[ToolCall]):
    model = ToolCall

    async def record(
        self,
        *,
        workflow_id: UUID,
        step_id: UUID,
        tool_name: str,
        status: ToolCallStatus,
        attempt: int,
        retry_count: int,
        duration_ms: int,
        input_json: dict[str, Any] | None = None,
        output_json: dict[str, Any] | None = None,
        error: str | None = None,
        started_at: datetime | None = None,
    ) -> ToolCall:
        row = ToolCall(
            workflow_id=workflow_id,
            step_id=step_id,
            tool_name=tool_name,
            status=status.value,
            attempt=attempt,
            retry_count=retry_count,
            duration_ms=duration_ms,
            input_json=input_json,
            output_json=output_json,
            error=error,
            started_at=started_at or datetime.now(UTC),
            completed_at=datetime.now(UTC),
        )
        self.session.add(row)
        await self.session.flush()
        return row

    async def for_workflow(self, workflow_id: UUID) -> Sequence[ToolCall]:
        return (
            await self.session.scalars(
                select(ToolCall)
                .where(ToolCall.workflow_id == workflow_id)
                .order_by(ToolCall.started_at)
            )
        ).all()


class WorkflowEventRepository(BaseRepository[WorkflowEvent]):
    """Durable WS event log, so a client that reconnects can catch up."""

    model = WorkflowEvent

    async def append(
        self, workflow_id: UUID, event_type: str, payload: dict[str, Any]
    ) -> int:
        """Append one event and return the cursor value clients replay from.

        That cursor is the row's own primary key. The previous scheme derived a
        per-workflow ``seq`` from MAX(seq)+1, which was wrong in two ways at
        once: it cost a second round trip on a ~200 ms link, twenty-odd times
        per workflow, and the read-then-write could interleave with a
        concurrent writer and collide on unique (workflow_id, seq). Folding the
        MAX into the INSERT as a subquery fixed the round trip but not the
        race -- two statements executing at the same instant still read the
        same maximum.

        A bigserial has neither problem. It is assigned by the database with no
        read at all, it is monotonic, and concurrent inserts cannot be handed
        the same value. Ordering by it gives clients exactly what ordering by
        ``seq`` gave them: events in the order they were written.
        """
        stmt = (
            pg_insert(WorkflowEvent)
            .values(workflow_id=workflow_id, type=event_type, payload=payload)
            .returning(WorkflowEvent.id)
        )
        return int((await self.session.execute(stmt)).scalar_one())

    async def replay_after(
        self, workflow_id: UUID, last_seq: int, *, limit: int = 500
    ) -> Sequence[WorkflowEvent]:
        """Catch-up for a client that reconnects mid-run.

        ``last_seq`` is the highest cursor the client has already rendered, so
        the comparison is strict -- it must not receive a frame twice.
        """
        return (
            await self.session.scalars(
                select(WorkflowEvent)
                .where(
                    WorkflowEvent.workflow_id == workflow_id,
                    WorkflowEvent.id > last_seq,
                )
                .order_by(WorkflowEvent.id)
                .limit(limit)
            )
        ).all()
