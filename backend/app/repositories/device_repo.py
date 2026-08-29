"""FCM device tokens.

The only interesting query here is ``tokens_for_approvers``: when the agent
pauses at the human gate, it has to reach whoever can actually clear the gate.
That is the org's admins, not the requester -- notifying the person who is
already watching the screen and cannot approve their own request would be
noise on both counts.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Sequence
from uuid import UUID

from sqlalchemy import delete, select

from app.db.models import FcmToken, User, Vendor
from app.repositories.base import BaseRepository
from app.schemas.enums import UserRole


class DeviceRepository(BaseRepository[FcmToken]):
    model = FcmToken

    async def register(
        self,
        *,
        user_id: UUID,
        token: str,
        platform: str = "android",
        device_id: str | None = None,
    ) -> FcmToken:
        """Upsert by (user, token).

        FCM re-issues a token on reinstall or a data clear, so the same device
        arrives under a new token and the old one is dead. Refreshing
        ``last_seen_at`` here is what lets stale rows be identified later.
        """
        existing = await self.session.scalar(
            select(FcmToken).where(
                FcmToken.user_id == user_id, FcmToken.token == token
            )
        )
        if existing is not None:
            existing.last_seen_at = datetime.now(UTC)
            existing.platform = platform
            if device_id:
                existing.device_id = device_id
            await self.session.flush()
            return existing

        # A token identifies a device, and a device has one user at a time.
        # If this token is registered to somebody else, that registration is
        # stale -- the phone was handed over, or a different account signed in
        # here. Clearing it on the way in is what makes the handover safe even
        # when the previous user's sign-out never reached us, so signing out
        # does not have to block on a network call to stay correct.
        await self.session.execute(
            delete(FcmToken).where(
                FcmToken.token == token, FcmToken.user_id != user_id
            )
        )

        # One row per physical device: a re-registration under a new token
        # replaces the old one rather than accumulating beside it.
        if device_id:
            await self.session.execute(
                delete(FcmToken).where(
                    FcmToken.user_id == user_id,
                    FcmToken.device_id == device_id,
                )
            )

        row = FcmToken(
            user_id=user_id,
            token=token,
            platform=platform,
            device_id=device_id,
        )
        self.session.add(row)
        await self.session.flush()
        return row

    async def unregister(self, *, user_id: UUID, token: str) -> int:
        result = await self.session.execute(
            delete(FcmToken).where(
                FcmToken.user_id == user_id, FcmToken.token == token
            )
        )
        return int(result.rowcount or 0)

    async def tokens_for_user(self, user_id: UUID) -> list[str]:
        rows = await self.session.scalars(
            select(FcmToken.token).where(FcmToken.user_id == user_id)
        )
        return list(rows.all())

    async def tokens_for_approvers(self, org_id: UUID | None) -> list[str]:
        """Every device belonging to someone who can clear the gate.

        Scoped to the org: an admin at another company must never be pushed
        another organisation's purchase order.
        """
        stmt = (
            select(FcmToken.token)
            .join(User, User.id == FcmToken.user_id)
            .where(User.role == UserRole.ADMIN.value)
        )
        if org_id is not None:
            stmt = stmt.where(User.org_id == org_id)
        rows = await self.session.scalars(stmt)
        return list(rows.all())

    async def approver_ids(self, org_id: UUID | None) -> list[UUID]:
        """Who can clear the gate. The inbox counterpart to
        ``tokens_for_approvers`` -- a notification row is addressed to a
        person, not to a device, so an admin with no phone still gets one."""
        stmt = select(User.id).where(User.role == UserRole.ADMIN.value)
        if org_id is not None:
            stmt = stmt.where(User.org_id == org_id)
        return list((await self.session.scalars(stmt)).all())

    async def vendor_user_id(self, vendor_id: UUID) -> UUID | None:
        """The person who runs a vendor, for their inbox."""
        return await self.session.scalar(
            select(Vendor.user_id).where(Vendor.id == vendor_id)
        )

    async def tokens_for_vendor(self, vendor_id: UUID) -> list[str]:
        """Devices belonging to the person who runs this vendor.

        A purchase order raised against a vendor's catalog is news they need
        without opening the app. The link is Vendor.user_id, which the schema
        has always had -- only the query was missing.
        """
        rows = await self.session.scalars(
            select(FcmToken.token)
            .join(User, User.id == FcmToken.user_id)
            .join(Vendor, Vendor.user_id == User.id)
            .where(Vendor.id == vendor_id)
        )
        return list(rows.all())

    async def tokens_for_users(self, user_ids: Sequence[UUID]) -> list[str]:
        if not user_ids:
            return []
        rows = await self.session.scalars(
            select(FcmToken.token).where(FcmToken.user_id.in_(list(user_ids)))
        )
        return list(rows.all())


__all__ = ["DeviceRepository"]
