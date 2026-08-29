"""Device registration for push.

    POST   /me/devices     register (or refresh) this device's FCM token
    DELETE /me/devices     forget it -- called on sign-out

A token is unique to (user, device). Registering the same one twice refreshes
``last_seen_at`` rather than inserting a duplicate, because FCM re-issues a
token whenever the app is reinstalled or its data cleared, and a table full of
dead tokens is how push quietly stops working.

Signing out deletes the row. Otherwise the next person to use the phone gets
another user's approval notifications.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, status

from app.api.deps import CurrentUserDep, SessionDep
from app.repositories.device_repo import DeviceRepository
from app.schemas.auth import FcmTokenRegister

router = APIRouter(prefix="/me/devices", tags=["devices"])


@router.post("", status_code=status.HTTP_201_CREATED, summary="Register for push")
async def register_device(
    body: FcmTokenRegister, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    row = await DeviceRepository(session).register(
        user_id=user.id,
        token=body.token,
        platform=body.platform,
        device_id=body.device_id,
    )
    return {
        "id": str(row.id),
        "platform": row.platform,
        "registered_at": row.created_at.isoformat(),
    }


@router.delete(
    "",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Forget this device (sign-out)",
)
async def unregister_device(
    body: FcmTokenRegister, user: CurrentUserDep, session: SessionDep
) -> None:
    await DeviceRepository(session).unregister(user_id=user.id, token=body.token)
