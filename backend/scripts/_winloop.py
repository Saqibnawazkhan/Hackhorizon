"""Windows event-loop shim.

psycopg's async mode cannot run on the ProactorEventLoop, which is the Python
default on Windows. Production runs on Linux where this is a no-op, but local
development needs the selector policy installed before any loop is created.
"""
from __future__ import annotations

import asyncio
import sys


def install() -> None:
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
