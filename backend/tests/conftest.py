"""Shared test fixtures.

Two concerns handled here:

1. Windows event loop -- psycopg's async mode cannot run on the default
   ProactorEventLoop, so any test that does touch Postgres needs the selector
   policy installed before a loop is created.

2. Environment isolation -- most of this suite tests pure logic and graph
   control flow. Once a real DATABASE_URL exists in .env those tests would
   silently start doing network I/O and become slow and flaky. ``no_database``
   pins them back to the offline path, so what they assert stays true whether
   or not a developer has credentials configured.
"""
from __future__ import annotations

import asyncio
import sys

import pytest

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


@pytest.fixture
def no_database(monkeypatch):
    """Force the offline path regardless of the developer's .env.

    Nodes check ``settings.database_configured`` before persisting, so
    blanking the URL exercises control flow with no I/O.
    """
    from app.core.config import settings

    monkeypatch.setattr(settings, "database_url", "", raising=False)
    yield settings


@pytest.fixture
def no_llm(monkeypatch):
    """Force the deterministic justification path (no Claude call)."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "anthropic_api_key", "", raising=False)
    yield settings
