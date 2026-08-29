"""Create the demo auth accounts and link the vendor profiles.

    python scripts/seed_users.py

Users cannot be inserted with SQL: Supabase Auth owns ``auth.users`` and
hashes the passwords. This uses the Auth admin API with the service key, then
links each vendor-role account to its vendor profile so ``auth_vendor_id()``
and the API guards resolve.

Idempotent: an account that already exists is updated, not duplicated.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _winloop import install as _install_winloop  # noqa: E402

_install_winloop()

import httpx  # noqa: E402

from app.core.config import settings  # noqa: E402

ORG_ID = "00000000-0000-0000-0000-0000000000a1"

DEMO_PASSWORD = "AgentFlow!2026"

ACCOUNTS = [
    {
        "email": "sara@agentflow.demo",
        "full_name": "Sara Ahmed",
        "role": "employee",
        "initials": "SA",
        "vendor_id": None,
    },
    {
        "email": "admin@agentflow.demo",
        "full_name": "Imran Malik",
        "role": "admin",
        "initials": "IM",
        "vendor_id": None,
    },
    {
        "email": "vendor@techsupplies.demo",
        "full_name": "TechSupplies Ltd",
        "role": "vendor",
        "initials": "TS",
        "vendor_id": "00000000-0000-0000-0000-0000000000b1",
    },
    {
        "email": "vendor@metrocomputers.demo",
        "full_name": "Metro Computers",
        "role": "vendor",
        "initials": "MC",
        "vendor_id": "00000000-0000-0000-0000-0000000000b2",
    },
]


def _headers() -> dict[str, str]:
    key = settings.supabase_service_role_key
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


async def _find_user(client: httpx.AsyncClient, email: str) -> dict | None:
    r = await client.get(
        f"{settings.supabase_url}/auth/v1/admin/users",
        headers=_headers(),
        params={"page": 1, "per_page": 200},
    )
    r.raise_for_status()
    for user in r.json().get("users", []):
        if (user.get("email") or "").lower() == email.lower():
            return user
    return None


async def _create_or_update(client: httpx.AsyncClient, account: dict) -> str:
    metadata = {
        "full_name": account["full_name"],
        "role": account["role"],
        "org_id": ORG_ID,
    }

    existing = await _find_user(client, account["email"])
    if existing:
        r = await client.put(
            f"{settings.supabase_url}/auth/v1/admin/users/{existing['id']}",
            headers=_headers(),
            json={
                "password": DEMO_PASSWORD,
                "email_confirm": True,
                "user_metadata": metadata,
                "app_metadata": {"role": account["role"], "org_id": ORG_ID},
            },
        )
        r.raise_for_status()
        print(f"  updated  {account['email']:<32} {account['role']}")
        return existing["id"]

    r = await client.post(
        f"{settings.supabase_url}/auth/v1/admin/users",
        headers=_headers(),
        json={
            "email": account["email"],
            "password": DEMO_PASSWORD,
            "email_confirm": True,
            "user_metadata": metadata,
            "app_metadata": {"role": account["role"], "org_id": ORG_ID},
        },
    )
    if r.status_code >= 300:
        raise RuntimeError(f"{account['email']}: {r.status_code} {r.text[:200]}")
    user_id = r.json()["id"]
    print(f"  created  {account['email']:<32} {account['role']}")
    return user_id


async def _link(user_ids: dict[str, str]) -> None:
    """Backfill public.users and attach vendor profiles.

    The signup trigger mirrors auth.users into public.users, but it fires only
    on INSERT -- so this reconciles both paths and is safe to re-run.
    """
    import psycopg

    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    async with await psycopg.AsyncConnection.connect(url, connect_timeout=30) as conn:
        async with conn.cursor() as cur:
            for account in ACCOUNTS:
                user_id = user_ids[account["email"]]
                await cur.execute(
                    """
                    insert into users (id, org_id, email, full_name, role, avatar_initials)
                    values (%s, %s, %s, %s, %s, %s)
                    on conflict (id) do update set
                        org_id = excluded.org_id,
                        email = excluded.email,
                        full_name = excluded.full_name,
                        role = excluded.role,
                        avatar_initials = excluded.avatar_initials
                    """,
                    (
                        user_id,
                        ORG_ID,
                        account["email"],
                        account["full_name"],
                        account["role"],
                        account["initials"],
                    ),
                )
                if account["vendor_id"]:
                    await cur.execute(
                        "update vendors set user_id = %s where id = %s",
                        (user_id, account["vendor_id"]),
                    )
        await conn.commit()
    print("  linked   public.users rows and vendor profiles")


async def main() -> int:
    if not settings.supabase_configured:
        print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.")
        return 2
    if not settings.database_configured:
        print("DATABASE_URL is not set.")
        return 2

    print(f"Seeding demo users on {settings.project_ref}")
    user_ids: dict[str, str] = {}
    async with httpx.AsyncClient(timeout=30.0) as client:
        for account in ACCOUNTS:
            user_ids[account["email"]] = await _create_or_update(client, account)

    await _link(user_ids)

    print()
    print("  Demo credentials (password is the same for all):")
    print(f"    password: {DEMO_PASSWORD}")
    for account in ACCOUNTS:
        print(f"    {account['role']:<9} {account['email']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
