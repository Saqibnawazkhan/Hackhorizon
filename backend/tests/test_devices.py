"""Device-token registration.

These protect one rule: a phone belongs to whoever is signed in on it right
now, and to nobody else. It matters because the thing pushed to that phone is
a purchase order awaiting approval.

The client used to guarantee this by deleting its token on sign-out, which
made signing out wait on a network round trip -- seconds of a screen that does
not move, which reads as a broken button. It now happens here instead, on the
way in, so a sign-out that never reached the server (flight mode, a
force-stop, a flat battery) cannot leave the previous user's registration
behind to receive the next user's notifications.

These run against the real schema rather than SQLite: ``users.id`` is a
foreign key into Supabase's ``auth.users``, and the columns are JSONB and
Postgres UUID, so an in-memory stand-in would be testing a different database
than the one that runs. Every test is wrapped in a transaction that is rolled
back, so the demo data is untouched. They skip when no database is configured.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import settings
from app.db.models import FcmToken, User
from app.db.session import get_engine
from app.repositories.device_repo import DeviceRepository

pytestmark = pytest.mark.skipif(
    not settings.database_configured,
    reason="needs the Postgres schema (users.id references auth.users)",
)

TOKEN = "test-fcm-token-for-one-physical-device"

SEEDED = {
    "admin": "admin@agentflow.demo",
    "employee": "sara@agentflow.demo",
    "vendor": "vendor@techsupplies.demo",
    "vendor2": "vendor@metrocomputers.demo",
}


@pytest.fixture
async def session():
    """A session on a transaction that is always rolled back.

    Nothing these tests write survives them, so they can run against the same
    database the demo uses without disturbing it.
    """
    engine = get_engine()
    async with engine.connect() as conn:
        transaction = await conn.begin()
        maker = async_sessionmaker(bind=conn, expire_on_commit=False)
        async with maker() as s:
            try:
                yield s
            finally:
                await s.close()
        await transaction.rollback()


@pytest.fixture
async def people(session):
    rows = (
        await session.scalars(
            select(User).where(User.email.in_(list(SEEDED.values())))
        )
    ).all()
    by_email = {u.email: u for u in rows}
    missing = [e for e in SEEDED.values() if e not in by_email]
    if missing:
        pytest.skip(f"seed users missing: {missing}")

    # Start from a clean slate: the running app may have registered a real
    # device, and these assertions are about exact contents.
    await session.execute(FcmToken.__table__.delete())
    await session.flush()
    return {k: by_email[v] for k, v in SEEDED.items()}


async def _owners(session) -> list[tuple[str, str]]:
    rows = (
        await session.execute(
            select(User.email, FcmToken.token).join(
                FcmToken, FcmToken.user_id == User.id
            )
        )
    ).all()
    return sorted((e, t) for e, t in rows)


# --------------------------------------------------------------------------
# Handover -- the rule that replaced the blocking sign-out
# --------------------------------------------------------------------------
async def test_registering_a_token_takes_it_from_the_previous_user(session, people):
    """One phone, one owner."""
    repo = DeviceRepository(session)
    await repo.register(user_id=people["vendor"].id, token=TOKEN)
    assert await _owners(session) == [(SEEDED["vendor"], TOKEN)]

    # The vendor signs out and an admin signs in. No unregister call ever
    # arrived -- the phone lost signal, or the app was force-stopped.
    await repo.register(user_id=people["admin"].id, token=TOKEN)

    assert await _owners(session) == [(SEEDED["admin"], TOKEN)], (
        "the vendor must not still be registered to this device"
    )


async def test_the_previous_user_stops_receiving_after_handover(session, people):
    repo = DeviceRepository(session)
    await repo.register(user_id=people["admin"].id, token=TOKEN)
    await repo.register(user_id=people["employee"].id, token=TOKEN)

    # An approval push goes to admins. This phone is now an employee's.
    assert await repo.tokens_for_approvers(people["admin"].org_id) == []
    assert await repo.tokens_for_user(people["employee"].id) == [TOKEN]


async def test_re_registering_the_same_user_is_idempotent(session, people):
    repo = DeviceRepository(session)
    first = await repo.register(user_id=people["admin"].id, token=TOKEN)
    second = await repo.register(user_id=people["admin"].id, token=TOKEN)

    assert first.id == second.id, "a refresh must not insert a second row"
    assert len(await _owners(session)) == 1


async def test_one_row_per_physical_device_across_token_rotations(session, people):
    """FCM reissues a token on reinstall; the dead one must not linger."""
    repo = DeviceRepository(session)
    await repo.register(
        user_id=people["admin"].id, token="old-token", device_id="phone-1"
    )
    await repo.register(
        user_id=people["admin"].id, token="new-token", device_id="phone-1"
    )

    assert await repo.tokens_for_user(people["admin"].id) == ["new-token"]


async def test_two_devices_for_one_user_both_survive(session, people):
    repo = DeviceRepository(session)
    await repo.register(
        user_id=people["admin"].id, token="phone-token", device_id="phone"
    )
    await repo.register(
        user_id=people["admin"].id, token="tablet-token", device_id="tablet"
    )

    assert sorted(await repo.tokens_for_user(people["admin"].id)) == [
        "phone-token",
        "tablet-token",
    ]


# --------------------------------------------------------------------------
# Who gets an approval push
# --------------------------------------------------------------------------
async def test_only_admins_are_pushed_approvals(session, people):
    repo = DeviceRepository(session)
    await repo.register(user_id=people["admin"].id, token="admin-tok")
    await repo.register(user_id=people["employee"].id, token="employee-tok")
    await repo.register(user_id=people["vendor"].id, token="vendor-tok")

    assert await repo.tokens_for_approvers(people["admin"].org_id) == [
        "admin-tok"
    ], (
        "an employee cannot clear the gate, and a vendor must never be shown "
        "a purchase order it is not party to"
    )


async def test_approver_lookup_is_scoped_to_the_org(session, people):
    """An admin elsewhere must never be pushed this org's purchase order."""
    from uuid import uuid4

    repo = DeviceRepository(session)
    await repo.register(user_id=people["admin"].id, token="ours")

    assert await repo.tokens_for_approvers(people["admin"].org_id) == ["ours"]
    assert await repo.tokens_for_approvers(uuid4()) == []


async def test_a_vendors_device_is_never_an_approver_device(session, people):
    repo = DeviceRepository(session)
    await repo.register(user_id=people["vendor"].id, token="v1")
    await repo.register(user_id=people["vendor2"].id, token="v2")

    assert await repo.tokens_for_approvers(people["admin"].org_id) == []


# --------------------------------------------------------------------------
# Unregister -- still used, just no longer load-bearing
# --------------------------------------------------------------------------
async def test_unregister_removes_only_that_users_token(session, people):
    repo = DeviceRepository(session)
    await repo.register(user_id=people["admin"].id, token="a1")
    await repo.register(user_id=people["employee"].id, token="e1")

    assert await repo.unregister(user_id=people["admin"].id, token="a1") == 1
    assert await _owners(session) == [(SEEDED["employee"], "e1")]


async def test_unregistering_someone_elses_token_is_a_no_op(session, people):
    repo = DeviceRepository(session)
    await repo.register(user_id=people["admin"].id, token=TOKEN)

    assert await repo.unregister(user_id=people["employee"].id, token=TOKEN) == 0
    assert await repo.tokens_for_user(people["admin"].id) == [TOKEN]


async def test_unregister_is_safe_when_nothing_is_registered(session, people):
    repo = DeviceRepository(session)
    assert await repo.unregister(user_id=people["admin"].id, token="never-seen") == 0


async def test_no_devices_means_no_tokens_not_an_error(session, people):
    repo = DeviceRepository(session)
    assert await repo.tokens_for_approvers(people["admin"].org_id) == []
    assert await repo.tokens_for_users([]) == []
