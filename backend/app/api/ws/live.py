"""WebSocket endpoint for live execution (screens 4a / 4b).

    ws://<host>/ws/workflows/{workflow_id}?access_token=<supabase jwt>&last_seq=0

Auth is a query parameter, not a header: browsers and several Flutter socket
clients cannot set Authorization on an upgrade request. The token is verified
with the same code path as every REST route, and the caller must be allowed to
see the workflow.

Catch-up: the client sends the highest sequence number it already has. Every
event after it is replayed from ``workflow_events`` before live frames begin,
so a phone that connects halfway through a run renders the full stepper rather
than an empty one.

Every event has a REST equivalent (GET /workflows/{id}), so a client that
cannot hold a socket open still works by polling.
"""
from __future__ import annotations

import asyncio
import contextlib
from uuid import UUID

import structlog
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from app.agent.orchestrator import events
from app.core.config import settings
from app.db.session import get_sessionmaker
from app.schemas.enums import UserRole

log = structlog.get_logger(__name__)

router = APIRouter(tags=["websocket"])


async def _authorise(websocket: WebSocket, workflow_id: UUID, token: str) -> bool:
    """Verify the JWT and confirm the caller may watch this workflow."""
    from app.api.deps import _resolve_user, decode_supabase_jwt
    from app.repositories.workflow_repo import WorkflowRepository

    try:
        claims = decode_supabase_jwt(token)
    except Exception as exc:  # noqa: BLE001 - closing is the only response
        log.info("ws.auth_failed", error=str(exc))
        await websocket.close(
            code=status.WS_1008_POLICY_VIOLATION, reason="invalid token"
        )
        return False

    async with get_sessionmaker()() as session:
        user = await _resolve_user(claims, session)

        # Vendors never see buyer workflows.
        if user.role is UserRole.VENDOR:
            await websocket.close(
                code=status.WS_1008_POLICY_VIOLATION, reason="forbidden"
            )
            return False

        workflow = await WorkflowRepository(session).get_visible(
            workflow_id,
            requester_id=user.id,
            org_id=user.org_id,
            is_admin=user.is_admin,
        )
        if workflow is None:
            await websocket.close(
                code=status.WS_1008_POLICY_VIOLATION, reason="not found"
            )
            return False

    return True


@router.websocket("/ws/workflows/{workflow_id}")
async def workflow_stream(
    websocket: WebSocket,
    workflow_id: UUID,
    access_token: str = Query(..., description="Supabase access token"),
    last_seq: int = Query(0, ge=0, description="Replay everything after this"),
) -> None:
    await websocket.accept()

    if settings.database_configured:
        if not await _authorise(websocket, workflow_id, access_token):
            return
    else:
        log.warning("ws.unauthenticated", reason="DATABASE_URL not configured")

    queue = events.subscribe(workflow_id)
    log.info(
        "ws.connected",
        workflow_id=str(workflow_id),
        last_seq=last_seq,
        subscribers=events.subscriber_count(workflow_id),
    )

    try:
        # 1. Catch up before anything live, so ordering is never interleaved.
        for frame in await events.replay(workflow_id, last_seq):
            await websocket.send_json(frame)

        # 2. Live frames, with a heartbeat so idle sockets are not reaped.
        while True:
            try:
                frame = await asyncio.wait_for(
                    queue.get(), timeout=settings.ws_heartbeat_seconds
                )
            except TimeoutError:
                await websocket.send_json(events.heartbeat_frame())
                continue
            await websocket.send_json(frame)

    except WebSocketDisconnect:
        log.info("ws.disconnected", workflow_id=str(workflow_id))
    except Exception as exc:  # noqa: BLE001 - never take the server down
        log.warning("ws.error", workflow_id=str(workflow_id), error=str(exc))
        with contextlib.suppress(Exception):
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
    finally:
        events.unsubscribe(workflow_id, queue)
