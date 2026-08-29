"""Database engine and session management.

The backend connects with the Supabase SERVICE ROLE credential, which bypasses
RLS by design -- the agent must write steps, quotes and POs on behalf of a user
who cannot write them directly. Scoping is therefore the repository layer's
job, and RLS is the safety net for anything reaching Postgres with a user JWT
(the Flutter app's direct reads, a future web dashboard).

Nothing here connects at import time, so the app boots and its tests run
before DATABASE_URL exists.
"""
from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from functools import lru_cache

import structlog
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings

log = structlog.get_logger(__name__)


class DatabaseNotConfiguredError(RuntimeError):
    """Raised when a query is attempted without DATABASE_URL."""


def _async_url(url: str) -> str:
    """Normalise a Supabase connection string to the async psycopg driver."""
    if url.startswith("postgresql+psycopg://"):
        return url
    if url.startswith("postgresql+asyncpg://"):
        # asyncpg does not support the statement cache settings we rely on
        # through PgBouncer; standardise on psycopg3.
        return url.replace("postgresql+asyncpg://", "postgresql+psycopg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+psycopg://", 1)
    return url


@lru_cache
def get_engine() -> AsyncEngine:
    if not settings.database_configured:
        raise DatabaseNotConfiguredError(
            "DATABASE_URL is not set. Copy the Session Pooler URI from "
            "Supabase > Connect and put it in backend/.env."
        )
    return create_async_engine(
        _async_url(settings.database_url),
        echo=settings.database_echo,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
        # pre_ping issues a round-trip `SELECT 1` on EVERY checkout. Against a
        # Supabase project in another region that is ~200ms added to every
        # single request, which dominated the perceived load time of every
        # screen -- measured: 1.5ms for a route that touches no database,
        # 700-1200ms for one that does, independent of how many rows it reads.
        #
        # pool_recycle below already retires connections well inside Supabase's
        # idle timeout, so pre_ping is largely redundant insurance. It stays
        # available for an environment where the pooler really does drop
        # connections early -- set DATABASE_POOL_PRE_PING=true there.
        pool_pre_ping=settings.database_pool_pre_ping,
        # Supabase drops idle connections; recycling below that keeps the pool
        # from handing out dead ones.
        pool_recycle=280,
        # Fail fast when saturated instead of hanging the request.
        pool_timeout=20,
        # Supabase's pooler does not support server-side prepared statements.
        connect_args={"prepare_threshold": None},
    )


@lru_cache
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(
        bind=get_engine(),
        class_=AsyncSession,
        expire_on_commit=False,
        autoflush=False,
    )


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency. Commits on success, rolls back on any exception."""
    async with get_sessionmaker()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


@asynccontextmanager
async def session_scope() -> AsyncGenerator[AsyncSession, None]:
    """Standalone context manager for background jobs and the agent runtime."""
    async with get_sessionmaker()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def ping() -> dict[str, object]:
    """Liveness probe surfaced at GET /health."""
    if not settings.database_configured:
        return {"configured": False, "reachable": False, "detail": "no DATABASE_URL"}
    from sqlalchemy import text

    try:
        async with session_scope() as session:
            await session.execute(text("select 1"))
    except Exception as exc:  # noqa: BLE001 - a probe must never raise
        return {
            "configured": True,
            "reachable": False,
            "detail": f"{type(exc).__name__}: {exc}",
        }
    return {"configured": True, "reachable": True}


async def dispose_engine() -> None:
    if get_engine.cache_info().currsize:
        await get_engine().dispose()
