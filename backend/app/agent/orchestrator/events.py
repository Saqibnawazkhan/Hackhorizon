"""Live execution event bus.

Two halves, deliberately:

  * DURABLE  -- every event is appended to ``workflow_events``, so a phone
    that connects late (or reconnects after a tunnel drop) replays exactly
    what it missed. The row id is the replay cursor.
  * LIVE     -- an in-process asyncio fan-out pushes the same event to any
    WebSocket currently subscribed.

The durable half is what makes screens 4a/4b correct rather than merely
pretty: without it, a client joining mid-run would show an empty stepper for a
workflow that is half finished.

The live half is per-process. A multi-replica deployment would swap this for
Postgres LISTEN/NOTIFY or Redis behind the same ``publish``/``subscribe``
interface; nothing outside this module would change.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import session_scope
from app.repositories.workflow_repo import WorkflowEventRepository
from app.schemas.enums import WSEventType

log = structlog.get_logger(__name__)

_subscribers: dict[str, set[asyncio.Queue]] = defaultdict(set)


def subscribe(workflow_id: UUID | str) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue(maxsize=settings.ws_replay_buffer_size)
    _subscribers[str(workflow_id)].add(queue)
    return queue


def unsubscribe(workflow_id: UUID | str, queue: asyncio.Queue) -> None:
    subs = _subscribers.get(str(workflow_id))
    if subs:
        subs.discard(queue)
        if not subs:
            _subscribers.pop(str(workflow_id), None)


def subscriber_count(workflow_id: UUID | str) -> int:
    return len(_subscribers.get(str(workflow_id), ()))


# Background event persistence.
#
# Event rows are telemetry: they let a client that reconnects catch up. Nothing
# in the run reads them back, so writing them inline was buying nothing and
# costing a round trip each -- about twenty per workflow, six seconds on a link
# to Tokyo.
#
# One lock per workflow, so its rows are inserted in the order they were
# emitted and the ids a replaying client sorts by match the order events
# actually happened. The lock is about ordering only; it is not protecting
# against collisions, because ids cannot collide.
_persist_locks: dict[str, asyncio.Lock] = {}
_persist_tasks: set[asyncio.Task] = set()
_inflight: dict[str, int] = {}


async def _persist(workflow_id: str, event_type: str, payload: dict[str, Any]) -> None:
    lock = _persist_locks.setdefault(workflow_id, asyncio.Lock())
    async with lock:
        try:
            async with session_scope() as session:
                await WorkflowEventRepository(session).append(
                    UUID(workflow_id), event_type, payload
                )
        except Exception as exc:  # noqa: BLE001 - telemetry never fails a run
            log.warning(
                "ws.persist_failed", workflow_id=workflow_id, error=str(exc)
            )


def _schedule_persist(
    workflow_id: str, event_type: str, payload: dict[str, Any]
) -> None:
    """Write the durable row without blocking the caller."""
    try:
        task = asyncio.create_task(_persist(workflow_id, event_type, payload))
    except RuntimeError:
        # No running loop (a sync context, or shutdown) -- drop the row rather
        # than raise. The live frame has already been delivered.
        return

    # Hold a reference, or the loop may garbage-collect the task mid-flight.
    _persist_tasks.add(task)
    _inflight[workflow_id] = _inflight.get(workflow_id, 0) + 1

    def _done(t: asyncio.Task) -> None:
        _persist_tasks.discard(t)
        remaining = _inflight.get(workflow_id, 1) - 1
        if remaining > 0:
            _inflight[workflow_id] = remaining
        else:
            # Last write for this workflow landed. Drop its lock, or a
            # long-lived server accumulates one per workflow it ever ran.
            _inflight.pop(workflow_id, None)
            _persist_locks.pop(workflow_id, None)

    task.add_done_callback(_done)


async def drain_pending_events() -> None:
    """Wait for outstanding event writes. Used at shutdown and in tests.

    Loops because draining is not a single generation: a task holding a
    workflow's lock releases it to the next queued write, which was scheduled
    before the drain began and must also land before the engine is disposed.
    """
    while _persist_tasks:
        await asyncio.gather(*list(_persist_tasks), return_exceptions=True)


def _fan_out(workflow_id: str, frame: dict[str, Any]) -> None:
    """Push to live subscribers. A slow client is dropped, never blocking."""
    for queue in list(_subscribers.get(workflow_id, ())):
        try:
            queue.put_nowait(frame)
        except asyncio.QueueFull:
            log.warning("ws.subscriber_lagging", workflow_id=workflow_id)


async def emit(
    workflow_id: UUID | str,
    event_type: WSEventType,
    payload: dict[str, Any],
    *,
    persist: bool = True,
    session: AsyncSession | None = None,
) -> dict[str, Any]:
    """Broadcast one event now; record it durably in the background.

    Anyone watching is served by the fan-out below, which is in-process and
    immediate. The durable row exists only so a client that connects late can
    catch up, and nobody is waiting on it -- so the run does not wait on it
    either.

    ``session`` is accepted for callers that hold one, but deliberately unused:
    binding the insert to a step's transaction put a network round trip in the
    middle of every step transition to buy atomicity that nothing reads.

    Live frames therefore carry ``seq: 0`` -- the row id is not known yet, and
    the client treats the field as a high-water mark it only ever raises, so a
    zero is ignored. Replayed frames carry the real cursor.
    """
    wf = str(workflow_id)

    if persist and settings.database_configured:
        _schedule_persist(wf, event_type.value, payload)

    frame = {
        "type": event_type.value,
        "workflow_id": wf,
        "seq": 0,
        "ts": datetime.now(UTC).isoformat(),
        "payload": payload,
    }
    _fan_out(wf, frame)
    return frame


async def replay(workflow_id: UUID, last_seq: int = 0) -> list[dict[str, Any]]:
    """Everything after ``last_seq`` -- the catch-up a late client needs."""
    if not settings.database_configured:
        return []
    async with session_scope() as session:
        rows = await WorkflowEventRepository(session).replay_after(
            workflow_id, last_seq, limit=settings.ws_replay_buffer_size
        )
        return [
            {
                "type": r.type,
                "workflow_id": str(r.workflow_id),
                "seq": r.id,
                "ts": r.created_at.isoformat(),
                "payload": r.payload,
            }
            for r in rows
        ]


def heartbeat_frame() -> dict[str, Any]:
    return {
        "type": WSEventType.HEARTBEAT.value,
        "workflow_id": None,
        "seq": 0,
        "ts": datetime.now(UTC).isoformat(),
        "payload": {"server_time": datetime.now(UTC).isoformat()},
    }
