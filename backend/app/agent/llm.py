"""Anthropic client factory.

One place constructs the client, so auth quirks and defaults are fixed once.

Identity-linked API keys must send ``anthropic-workspace-id``; workspace-scoped
keys must not care. Passing it as a default header keeps every call site --
planner, justification narrator, future tools -- free of that detail.
"""
from __future__ import annotations

from functools import lru_cache

import anthropic
import structlog

from app.core.config import settings

log = structlog.get_logger(__name__)


class LLMNotConfiguredError(RuntimeError):
    """Raised when a Claude call is attempted without credentials.

    Callers catch this and fall back to deterministic behaviour rather than
    failing the workflow: the scoring maths and the validator never need an
    LLM, so a missing key degrades explanations, not decisions.
    """


@lru_cache
def get_client() -> anthropic.Anthropic:
    if not settings.anthropic_configured:
        raise LLMNotConfiguredError(
            "ANTHROPIC_API_KEY is not set. The planner and the justification "
            "narrator require it; scoring and validation do not."
        )

    default_headers: dict[str, str] = {}
    if settings.anthropic_workspace_id:
        default_headers["anthropic-workspace-id"] = settings.anthropic_workspace_id

    return anthropic.Anthropic(
        api_key=settings.anthropic_api_key,
        default_headers=default_headers or None,
        timeout=settings.agent.llm_timeout_seconds,
        max_retries=2,
    )


@lru_cache
def get_async_client() -> anthropic.AsyncAnthropic:
    if not settings.anthropic_configured:
        raise LLMNotConfiguredError("ANTHROPIC_API_KEY is not set.")

    default_headers: dict[str, str] = {}
    if settings.anthropic_workspace_id:
        default_headers["anthropic-workspace-id"] = settings.anthropic_workspace_id

    return anthropic.AsyncAnthropic(
        api_key=settings.anthropic_api_key,
        default_headers=default_headers or None,
        timeout=settings.agent.llm_timeout_seconds,
        max_retries=2,
    )


def extract_text(message: anthropic.types.Message) -> str:
    """Concatenate the text blocks of a response, ignoring thinking blocks."""
    return "".join(
        block.text for block in message.content if block.type == "text"
    ).strip()


async def health_check() -> dict[str, object]:
    """Cheap liveness probe surfaced at GET /health."""
    if not settings.anthropic_configured:
        return {"configured": False, "reachable": False, "detail": "no API key"}
    try:
        client = get_async_client()
        await client.messages.create(
            model=settings.agent.model,
            max_tokens=16,
            messages=[{"role": "user", "content": "ping"}],
        )
    except Exception as exc:  # noqa: BLE001 - a probe must never raise
        return {
            "configured": True,
            "reachable": False,
            "detail": f"{type(exc).__name__}: {exc}",
        }
    return {"configured": True, "reachable": True, "model": settings.agent.model}
