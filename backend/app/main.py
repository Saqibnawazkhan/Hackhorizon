"""AgentFlow API.

A clean REST + WebSocket surface with no Flutter-specific logic: the mobile
app and the future web dashboard are both just clients. OpenAPI docs at /docs.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.agent.llm import LLMNotConfiguredError
from app.core.config import settings
from app.db.session import DatabaseNotConfiguredError
from app.repositories.base import NotFoundError
from app.schemas.common import ErrorDetail, ErrorEnvelope

structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="%Y-%m-%d %H:%M:%S"),
        structlog.dev.ConsoleRenderer(colors=False),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(
        logging.DEBUG if settings.debug else logging.INFO
    ),
)
log = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail fast on a malformed workflow template or an unregistered tool,
    # rather than halfway through someone's live run.
    from app.agent.orchestrator.template import load_all
    from app.agent.tools import registry as tool_registry

    tool_registry._load_builtin_tools()
    templates = load_all()

    log.info(
        "startup",
        environment=settings.environment,
        tools=tool_registry.available(),
        workflow_types=sorted(templates),
        database=settings.database_configured,
        supabase=settings.supabase_configured,
        anthropic=settings.anthropic_configured,
    )
    if not settings.database_configured:
        log.warning("startup.no_database", detail="DATABASE_URL is not set")
    if not settings.anthropic_configured:
        log.warning("startup.no_anthropic", detail="ANTHROPIC_API_KEY is not set")

    yield

    from app.agent.orchestrator.events import drain_pending_events
    from app.agent.orchestrator.graph import close_checkpointer
    from app.db.session import dispose_engine

    if settings.database_configured:
        await drain_pending_events()
        await close_checkpointer()
        await dispose_engine()
    log.info("shutdown")


app = FastAPI(
    title="AgentFlow API",
    version="0.1.0",
    description=(
        "Agentic AI for autonomous business workflow execution.\n\n"
        "A user submits a plain-English business request. The agent parses it, "
        "publishes a visible execution plan, executes each step, makes a "
        "transparent scored decision, validates its own output, self-corrects "
        "on failure, and pauses at a mandatory human approval gate before any "
        "spend is committed."
    ),
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# Uniform error envelope -- every non-2xx body has the same shape
# --------------------------------------------------------------------------
def _envelope(
    code: str, message: str, details: list[ErrorDetail] | None = None
) -> dict:
    return ErrorEnvelope(
        error=code, message=message, details=details or []
    ).model_dump(mode="json", exclude_none=True)


@app.exception_handler(RequestValidationError)
async def _validation_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content=_envelope(
            "validation_error",
            "The request body or parameters failed validation.",
            [
                ErrorDetail(
                    field=".".join(str(p) for p in e["loc"][1:]) or None,
                    message=e["msg"],
                )
                for e in exc.errors()
            ],
        ),
    )


@app.exception_handler(NotFoundError)
async def _not_found_handler(request: Request, exc: NotFoundError):
    return JSONResponse(
        status_code=status.HTTP_404_NOT_FOUND,
        content=_envelope("not_found", str(exc)),
    )


@app.exception_handler(DatabaseNotConfiguredError)
async def _no_database_handler(request: Request, exc: DatabaseNotConfiguredError):
    """A missing dependency is a 503 the operator can act on, not an opaque 500."""
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content=_envelope("database_not_configured", str(exc)),
    )


@app.exception_handler(LLMNotConfiguredError)
async def _no_llm_handler(request: Request, exc: LLMNotConfiguredError):
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content=_envelope("llm_not_configured", str(exc)),
    )


@app.exception_handler(Exception)
async def _unhandled_handler(request: Request, exc: Exception):
    log.exception("unhandled", path=request.url.path)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=_envelope(
            "internal_error",
            str(exc) if settings.debug else "An unexpected error occurred.",
        ),
    )


# --------------------------------------------------------------------------
# Health and introspection
# --------------------------------------------------------------------------
@app.get("/", tags=["meta"], summary="Service banner")
async def root() -> dict:
    return {
        "service": settings.app_name,
        "version": app.version,
        "environment": settings.environment,
        "docs": "/docs",
    }


@app.get("/health", tags=["meta"], summary="Liveness and dependency status")
async def health() -> dict:
    from app.agent import llm
    from app.agent.orchestrator.template import available_templates
    from app.agent.tools import registry as tool_registry
    from app.db import session as db

    tool_registry._load_builtin_tools()
    return {
        "status": "ok",
        "environment": settings.environment,
        "currency": settings.default_currency,
        "database": await db.ping(),
        "anthropic": {
            "configured": settings.anthropic_configured,
            "model": settings.agent.model,
            "workspace_id_set": bool(settings.anthropic_workspace_id),
        },
        "supabase": {
            "configured": settings.supabase_configured,
            "bucket": settings.supabase_storage_bucket,
        },
        "tools": tool_registry.available(),
        "workflow_types": available_templates(),
        "scoring": {
            "weights": {
                "price": settings.scoring.weight_price,
                "delivery": settings.scoring.weight_delivery,
                "warranty": settings.scoring.weight_warranty,
                "reliability": settings.scoring.weight_reliability,
            },
            "self_correction_limit": settings.agent.max_self_correction_attempts,
            "tool_retry_limit": settings.agent.tool_max_attempts,
        },
    }


@app.get(
    "/api/v1/meta/workflow-types",
    tags=["meta"],
    summary="Registered workflow types and their compiled graphs",
)
async def workflow_types() -> list[dict]:
    """Introspection: proves adding a workflow type is config, not code."""
    from app.agent.orchestrator.graph import describe_graph
    from app.agent.orchestrator.template import load_all

    return [describe_graph(t) for t in load_all().values()]


@app.get(
    "/api/v1/meta/tools",
    tags=["meta"],
    summary="Registered agent tools",
)
async def tools() -> list[dict]:
    from app.agent.tools import registry as tool_registry

    tool_registry._load_builtin_tools()
    return tool_registry.describe()


# --------------------------------------------------------------------------
# Routers
# --------------------------------------------------------------------------
def _mount_routers() -> None:
    from app.api.v1.routers import (
        admin,
        approvals,
        catalog,
        devices,
        imports,
        notifications,
        rfq,
        vendors,
        workflows,
    )
    from app.api.ws import live

    prefix = settings.api_v1_prefix
    app.include_router(workflows.router, prefix=prefix)
    # Mounted after workflows so /workflows/{id}/quote-requests sits beside
    # the rest of that resource in the OpenAPI page rather than adrift.
    app.include_router(rfq.router, prefix=prefix)
    app.include_router(approvals.router, prefix=prefix)
    app.include_router(vendors.router, prefix=prefix)
    app.include_router(catalog.router, prefix=prefix)
    app.include_router(imports.router, prefix=prefix)
    app.include_router(devices.router, prefix=prefix)
    app.include_router(notifications.router, prefix=prefix)
    app.include_router(admin.router, prefix=prefix)
    app.include_router(live.router)


_mount_routers()
