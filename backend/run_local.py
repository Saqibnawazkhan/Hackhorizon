"""Local development server.

    python run_local.py [--reload]

Exists because psycopg's async mode cannot run on Windows' default
ProactorEventLoop, and uvicorn *re-installs* the proactor policy during its
own loop setup -- so setting the policy and calling ``uvicorn.run`` is not
enough. Building the server with ``loop="none"`` and driving it from our own
``asyncio.run`` keeps the selector loop.

On Linux (Railway, Render, Docker) none of this applies and
``uvicorn app.main:app`` works directly -- see the Procfile.
"""
from __future__ import annotations

import asyncio
import os
import sys

import uvicorn

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "info")


def main() -> None:
    reload = "--reload" in sys.argv

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        if reload:
            # The reloader spawns a subprocess that would re-enter uvicorn's
            # own setup and lose the policy, so it is not supported here.
            print(
                "note: --reload is unavailable on Windows with the selector "
                "loop; restart manually after changes."
            )
            reload = False

        config = uvicorn.Config(
            "app.main:app",
            host=HOST,
            port=PORT,
            log_level=LOG_LEVEL,
            loop="none",  # do not let uvicorn install a policy
        )
        server = uvicorn.Server(config)
        asyncio.run(server.serve())
        return

    uvicorn.run(
        "app.main:app",
        host=HOST,
        port=PORT,
        reload=reload,
        log_level=LOG_LEVEL,
    )


if __name__ == "__main__":
    main()
