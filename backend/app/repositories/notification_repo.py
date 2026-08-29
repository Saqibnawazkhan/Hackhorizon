"""The notification inbox behind the bell.

A push is a moment: dismissed, or arriving while the phone is off, and it is
gone. These rows are what a user comes back to, and what an unread count can
be counted from.

Written alongside every push, to the same recipients, so the inbox cannot
drift out of step with what was actually sent.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Sequence
from uuid import UUID

from sqlalchemy import func, select, update

from app.db.models import Notification
from app.repositories.base import BaseRepository


class NotificationRepository(BaseRepository[Notification]):
    model = Notification

    async def fan_out(
        self,
        *,
        user_ids: Sequence[UUID],
        kind: str,
        title: str,
        body: str,
        org_id: UUID | None = None,
        deep_link: str | None = None,
        workflow_id: UUID | None = None,
    ) -> int:
        """One row per recipient, in one insert.

        Deliberately mirrors the push fan-out: the same event reaching three
        admins is three rows, because read state belongs to a person, not to
        the event. One admin reading it must not clear the other two's bell.
        """
        recipients = list(dict.fromkeys(user_ids))  # de-dupe, keep order
        if not recipients:
            return 0

        self.session.add_all(
            [
                Notification(
                    user_id=user_id,
                    org_id=org_id,
                    kind=kind,
                    title=title,
                    body=body,
                    deep_link=deep_link,
                    workflow_id=workflow_id,
                )
                for user_id in recipients
            ]
        )
        await self.session.flush()
        return len(recipients)

    async def unread_count(self, user_id: UUID) -> int:
        """The number on the bell. Backed by a partial index."""
        return int(
            await self.session.scalar(
                select(func.count())
                .select_from(Notification)
                .where(
                    Notification.user_id == user_id,
                    Notification.read_at.is_(None),
                )
            )
            or 0
        )

    async def inbox(
        self, user_id: UUID, *, limit: int = 50, unread_only: bool = False
    ) -> tuple[Sequence[Notification], int]:
        """Newest first, with the unread count in the same round trip's worth
        of work as the list itself would have cost alone."""
        stmt = select(Notification).where(Notification.user_id == user_id)
        if unread_only:
            stmt = stmt.where(Notification.read_at.is_(None))
        rows = (
            await self.session.scalars(
                stmt.order_by(Notification.created_at.desc()).limit(limit)
            )
        ).all()
        return rows, await self.unread_count(user_id)

    async def mark_read(
        self, user_id: UUID, *, notification_ids: Sequence[UUID] | None = None
    ) -> int:
        """Mark some, or all, of this user's notifications read.

        Scoped to the caller in the statement itself, so passing somebody
        else's id marks nothing rather than being a way to clear their bell.
        Already-read rows are excluded so read_at keeps meaning "when it was
        first seen".
        """
        stmt = (
            update(Notification)
            .where(
                Notification.user_id == user_id,
                Notification.read_at.is_(None),
            )
            .values(read_at=datetime.now(UTC))
        )
        if notification_ids is not None:
            if not notification_ids:
                return 0
            stmt = stmt.where(Notification.id.in_(list(notification_ids)))
        result = await self.session.execute(stmt)
        return int(result.rowcount or 0)


__all__ = ["NotificationRepository"]
