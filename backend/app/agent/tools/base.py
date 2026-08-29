"""Tool interface and the retry/logging wrapper every tool runs inside.

Adding a tool is one new file plus one ``register()`` line. The orchestrator
never learns a tool's name: nodes look tools up by the key written in the
workflow YAML, so a new tool is reachable from a new workflow template with no
Python change at all.

Guarantees this wrapper provides, so no individual tool has to:
  * exponential backoff, attempts and delays from settings
  * a hard timeout per attempt
  * one ``tool_calls`` row per attempt -- successes AND failures
  * a failure is returned as a ToolResult, never raised past the node, so a
    tool outage degrades the workflow instead of crashing it
"""
from __future__ import annotations

import asyncio
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar
from uuid import UUID

import structlog

from app.core.config import settings
from app.schemas.enums import ToolCallStatus

log = structlog.get_logger(__name__)

TIn = TypeVar("TIn")
TOut = TypeVar("TOut")


class ToolError(Exception):
    """Raised inside a tool to signal a retryable failure."""

    retryable: bool = True


class PermanentToolError(ToolError):
    """A failure that retrying cannot fix -- stop immediately."""

    retryable = False


@dataclass(slots=True)
class ToolContext:
    """Ambient information a tool may need. Never a database session."""

    workflow_id: UUID
    step_id: UUID | None = None
    org_id: UUID | None = None
    currency: str = field(default_factory=lambda: settings.default_currency)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ToolAttempt:
    """One physical invocation, logged to ``tool_calls`` whatever the outcome."""

    attempt: int
    status: ToolCallStatus
    duration_ms: int
    error: str | None = None
    output: Any = None


@dataclass(slots=True)
class ToolResult(Generic[TOut]):
    """What a node receives. Never raises past the wrapper."""

    tool_name: str
    ok: bool
    value: TOut | None
    attempts: list[ToolAttempt]
    error: str | None = None

    @property
    def retry_count(self) -> int:
        return max(0, len(self.attempts) - 1)

    @property
    def duration_ms(self) -> int:
        return sum(a.duration_ms for a in self.attempts)

    @property
    def final_status(self) -> ToolCallStatus:
        if self.ok:
            return (
                ToolCallStatus.RETRIED if self.retry_count else ToolCallStatus.SUCCESS
            )
        return self.attempts[-1].status if self.attempts else ToolCallStatus.FAILED

    def unwrap(self) -> TOut:
        if not self.ok or self.value is None:
            raise ToolError(f"{self.tool_name} failed: {self.error}")
        return self.value


class Tool(ABC, Generic[TIn, TOut]):
    """Common interface. Implementations only write ``run``."""

    name: str
    description: str = ""
    #: Per-tool override; falls back to the global setting.
    max_attempts: int | None = None
    timeout_seconds: float | None = None

    @abstractmethod
    async def run(self, payload: TIn, ctx: ToolContext) -> TOut:
        """Do the work. Raise ToolError to trigger a retry."""

    # -- execution wrapper ---------------------------------------------
    async def execute(self, payload: TIn, ctx: ToolContext) -> ToolResult[TOut]:
        cfg = settings.agent
        attempts_allowed = self.max_attempts or cfg.tool_max_attempts
        timeout = self.timeout_seconds or cfg.tool_timeout_seconds
        attempts: list[ToolAttempt] = []
        delay = cfg.tool_backoff_base_seconds

        for attempt in range(1, attempts_allowed + 1):
            started = time.perf_counter()
            try:
                value = await asyncio.wait_for(
                    self.run(payload, ctx), timeout=timeout
                )
            except TimeoutError:
                elapsed = int((time.perf_counter() - started) * 1000)
                attempts.append(
                    ToolAttempt(
                        attempt=attempt,
                        status=ToolCallStatus.TIMEOUT,
                        duration_ms=elapsed,
                        error=f"timed out after {timeout}s",
                    )
                )
                log.warning(
                    "tool.timeout", tool=self.name, attempt=attempt,
                    workflow_id=str(ctx.workflow_id),
                )
            except PermanentToolError as exc:
                elapsed = int((time.perf_counter() - started) * 1000)
                attempts.append(
                    ToolAttempt(
                        attempt=attempt,
                        status=ToolCallStatus.FAILED,
                        duration_ms=elapsed,
                        error=str(exc),
                    )
                )
                log.error(
                    "tool.permanent_failure", tool=self.name, error=str(exc),
                    workflow_id=str(ctx.workflow_id),
                )
                return ToolResult(
                    tool_name=self.name,
                    ok=False,
                    value=None,
                    attempts=attempts,
                    error=str(exc),
                )
            except Exception as exc:  # noqa: BLE001 - deliberate: never crash a run
                elapsed = int((time.perf_counter() - started) * 1000)
                attempts.append(
                    ToolAttempt(
                        attempt=attempt,
                        status=ToolCallStatus.FAILED,
                        duration_ms=elapsed,
                        error=f"{type(exc).__name__}: {exc}",
                    )
                )
                log.warning(
                    "tool.failed", tool=self.name, attempt=attempt,
                    error=str(exc), workflow_id=str(ctx.workflow_id),
                )
            else:
                elapsed = int((time.perf_counter() - started) * 1000)
                attempts.append(
                    ToolAttempt(
                        attempt=attempt,
                        status=ToolCallStatus.SUCCESS,
                        duration_ms=elapsed,
                        output=value,
                    )
                )
                return ToolResult(
                    tool_name=self.name, ok=True, value=value, attempts=attempts
                )

            if attempt < attempts_allowed:
                await asyncio.sleep(delay)
                delay = min(
                    delay * cfg.tool_backoff_multiplier, cfg.tool_backoff_max_seconds
                )

        return ToolResult(
            tool_name=self.name,
            ok=False,
            value=None,
            attempts=attempts,
            error=attempts[-1].error if attempts else "no attempts made",
        )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Tool {self.name}>"
