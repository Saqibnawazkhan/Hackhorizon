"""The notification inbox behind the bell.

    GET  /me/notifications        the inbox, newest first, with the unread count
    GET  /me/notifications/count  just the count -- what the bell polls
    POST /me/notifications/read   mark some, or all, read

Every route is scoped to the caller in the query itself. There is no route by
which one user reads or clears another's notifications.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from app.api.deps import CurrentUserDep, SessionDep
from app.repositories.notification_repo import NotificationRepository

router = APIRouter(prefix="/me/notifications", tags=["notifications"])


class MarkReadRequest(BaseModel):
    """Empty body means "all of mine"."""

    notification_ids: list[UUID] | None = Field(
        None,
        description="Specific notifications to mark read. Omit to mark all.",
    )


def _serialize(row) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "kind": row.kind,
        "title": row.title,
        "body": row.body,
        "deep_link": row.deep_link,
        "workflow_id": str(row.workflow_id) if row.workflow_id else None,
        "read": row.read_at is not None,
        "read_at": row.read_at.isoformat() if row.read_at else None,
        "created_at": row.created_at.isoformat(),
    }


@router.get("", summary="My notifications, newest first")
async def list_notifications(
    user: CurrentUserDep,
    session: SessionDep,
    limit: int = Query(50, ge=1, le=200),
    unread_only: bool = Query(False),
) -> dict[str, Any]:
    rows, unread = await NotificationRepository(session).inbox(
        user.id, limit=limit, unread_only=unread_only
    )
    return {
        "items": [_serialize(r) for r in rows],
        "unread_count": unread,
        "total": len(rows),
    }


@router.get("/count", summary="Unread count -- the number on the bell")
async def unread_count(user: CurrentUserDep, session: SessionDep) -> dict[str, int]:
    """Deliberately its own endpoint.

    The bell is on every screen, so this is the most-called route in the app.
    It is one indexed count and nothing else -- no joins, no serialisation of
    rows the caller is not going to render.
    """
    return {"unread_count": await NotificationRepository(session).unread_count(user.id)}


@router.post("/read", summary="Mark notifications read")
async def mark_read(
    body: MarkReadRequest, user: CurrentUserDep, session: SessionDep
) -> dict[str, int]:
    repo = NotificationRepository(session)
    marked = await repo.mark_read(user.id, notification_ids=body.notification_ids)
    return {"marked": marked, "unread_count": await repo.unread_count(user.id)}
