"""Apply the SQL migrations in order.

    python scripts/apply_migrations.py            # schema + RLS + seed
    python scripts/apply_migrations.py --no-seed  # schema + RLS only
    python scripts/apply_migrations.py --check    # connectivity only

Uses DATABASE_URL from backend/.env. Each file runs in its own transaction, so
a failure leaves the earlier files applied and reports exactly which statement
broke.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _winloop import install as _install_winloop  # noqa: E402

_install_winloop()

from app.core.config import settings  # noqa: E402

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"
ORDER = ["001_schema.sql", "002_rls.sql", "003_seed.sql", "004_seed_fixes.sql", "005_seed_lowstock.sql", "006_policy_scope.sql", "007_event_cursor.sql", "008_justification.sql", "009_notifications.sql", "010_rfq_and_po_closeout.sql"]

#: Files that write demo rows. --no-seed skips exactly these.
SEEDS = {"003_seed.sql", "004_seed_fixes.sql", "005_seed_lowstock.sql"}


def _libpq_url(url: str) -> str:
    """psycopg wants a plain libpq URI, not a SQLAlchemy driver URL."""
    for prefix in ("postgresql+psycopg://", "postgresql+asyncpg://"):
        if url.startswith(prefix):
            return url.replace(prefix, "postgresql://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql://", 1)
    return url


async def check() -> bool:
    import psycopg

    url = _libpq_url(settings.database_url)
    try:
        async with await psycopg.AsyncConnection.connect(url, connect_timeout=15) as conn:
            async with conn.cursor() as cur:
                await cur.execute("select version(), current_database(), current_user")
                version, db, user = await cur.fetchone()
        print(f"  connected  : {db} as {user}")
        print(f"  server     : {version.split(',')[0]}")
        return True
    except Exception as exc:
        print(f"  FAILED: {type(exc).__name__}: {exc}")
        return False


async def apply(files: list[str]) -> int:
    import psycopg

    url = _libpq_url(settings.database_url)
    failures = 0

    for name in files:
        path = MIGRATIONS / name
        if not path.exists():
            print(f"  {name:<20} SKIP (not found)")
            continue

        sql = path.read_text(encoding="utf-8")
        try:
            async with await psycopg.AsyncConnection.connect(
                url, connect_timeout=30, autocommit=False
            ) as conn:
                # NOTICE messages carry the seed verification output.
                conn.add_notice_handler(
                    lambda diag: print(f"      note: {diag.message_primary}")
                )
                async with conn.cursor() as cur:
                    await cur.execute(sql)
                await conn.commit()
            print(f"  {name:<20} OK ({len(sql.splitlines())} lines)")
        except Exception as exc:
            failures += 1
            print(f"  {name:<20} FAILED")
            print(f"      {type(exc).__name__}: {exc}")
    return failures


async def summary() -> None:
    import psycopg

    url = _libpq_url(settings.database_url)
    async with await psycopg.AsyncConnection.connect(url, connect_timeout=15) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "select count(*) from information_schema.tables "
                "where table_schema = 'public'"
            )
            (tables,) = await cur.fetchone()

            await cur.execute(
                "select count(*) from pg_tables t "
                "where t.schemaname = 'public' and t.rowsecurity = true"
            )
            (rls,) = await cur.fetchone()

            await cur.execute("select count(*) from pg_policies where schemaname='public'")
            (policies,) = await cur.fetchone()

            counts = {}
            for table in ("vendors", "catalog_items", "policy_rules", "scoring_weights"):
                try:
                    await cur.execute(f"select count(*) from {table}")
                    (counts[table],) = await cur.fetchone()
                except Exception:
                    counts[table] = "-"

    print()
    print("  === schema summary ===")
    print(f"  public tables       : {tables}")
    print(f"  RLS-enabled tables  : {rls}")
    print(f"  RLS policies        : {policies}")
    for table, count in counts.items():
        print(f"  {table:<20}: {count}")


async def main() -> int:
    parser = argparse.ArgumentParser(description="Apply AgentFlow migrations")
    parser.add_argument("--no-seed", action="store_true", help="schema + RLS only")
    parser.add_argument("--check", action="store_true", help="connectivity only")
    parser.add_argument(
        "--only",
        metavar="FILE",
        action="append",
        help="Apply just this migration (repeatable). Accepts the file name "
        "or its numeric prefix, e.g. --only 010. Use this to add a new "
        "migration to a database that already holds real data, rather than "
        "re-running the seeds over it.",
    )
    args = parser.parse_args()

    print("AgentFlow migrations")
    print(f"  project    : {settings.project_ref or '(unknown)'}")

    if not settings.database_configured:
        print()
        print("  DATABASE_URL is not set in backend/.env.")
        print("  Supabase dashboard > Connect > ORM/Direct, then paste the")
        print("  Session Pooler URI (port 5432) with your database password.")
        return 2

    # Never print credentials.
    safe = settings.database_url
    if "@" in safe:
        safe = safe.split("@", 1)[1]
    print(f"  target     : {safe}")
    print()

    if not await check():
        return 1
    if args.check:
        return 0

    print()
    if args.only:
        files = []
        for wanted in args.only:
            matches = [
                name
                for name in ORDER
                if name == wanted or name.startswith(f"{wanted}_") or name.startswith(wanted)
            ]
            if not matches:
                print(f"  no migration matches {wanted!r}")
                return 2
            files.extend(matches)
        # Preserve ORDER, and never apply the same file twice.
        files = [name for name in ORDER if name in set(files)]
    elif args.no_seed:
        # SEEDS is named explicitly: slicing the tail dropped whichever
        # migration happened to be newest, which is the opposite of the
        # intent and got quietly wrong every time a file was appended.
        files = [name for name in ORDER if name not in SEEDS]
    else:
        files = ORDER

    failures = await apply(files)
    if failures == 0:
        await summary()
    print()
    print("  done" if failures == 0 else f"  {failures} file(s) failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
