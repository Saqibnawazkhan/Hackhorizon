"""The planner: free text in, validated ``PlannerOutput`` out.

Contract:
  * strict JSON only, parsed through Pydantic
  * on a validation failure, re-prompt with the exact error appended, up to
    ``settings.agent.planner_max_parse_attempts`` times
  * ``workflow_type`` is inferred from the text; no client hint is accepted

Every attempt is recorded so screen 10b can show that the agent corrected its
own malformed output -- that is part of the transparency story, not an
embarrassment to hide.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

import structlog
from pydantic import ValidationError

from app.agent.llm import LLMNotConfiguredError, extract_text, get_async_client
from app.agent.planner.prompts import (
    build_planner_system_prompt,
    build_retry_prompt,
)
from app.core.config import settings
from app.schemas.planner import PlannerOutput

log = structlog.get_logger(__name__)

_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.MULTILINE)


class PlannerError(RuntimeError):
    """The planner could not produce valid output within the attempt budget."""

    def __init__(self, message: str, attempts: int, last_raw: str | None) -> None:
        super().__init__(message)
        self.attempts = attempts
        self.last_raw = last_raw


@dataclass(slots=True)
class PlannerAttempt:
    attempt: int
    ok: bool
    error: str | None = None
    raw: str | None = None


@dataclass(slots=True)
class PlannerResult:
    output: PlannerOutput
    attempts: list[PlannerAttempt] = field(default_factory=list)

    @property
    def attempt_count(self) -> int:
        return len(self.attempts)

    @property
    def self_corrected(self) -> bool:
        return self.attempt_count > 1


def _strip_fences(text: str) -> str:
    """Models occasionally wrap JSON in a code fence despite instructions."""
    cleaned = _FENCE.sub("", text).strip()
    # Salvage the outermost object if the model added stray prose.
    if not cleaned.startswith("{"):
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start != -1 and end > start:
            cleaned = cleaned[start : end + 1]
    return cleaned


def parse_planner_output(raw: str) -> PlannerOutput:
    """Parse and validate. Raises ValidationError or ValueError."""
    cleaned = _strip_fences(raw)
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"reply was not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"expected a JSON object, got {type(payload).__name__}")
    return PlannerOutput.model_validate(payload)


class Planner:
    """Wraps the Claude call and the validate-and-retry loop."""

    def __init__(self, model: str | None = None) -> None:
        self.model = model or settings.agent.model

    async def plan(self, request_text: str) -> PlannerResult:
        schema = PlannerOutput.model_json_schema()
        system = build_planner_system_prompt(schema)
        client = get_async_client()

        messages: list[dict] = [{"role": "user", "content": request_text}]
        attempts: list[PlannerAttempt] = []
        max_attempts = settings.agent.planner_max_parse_attempts
        last_raw: str | None = None

        for attempt in range(1, max_attempts + 1):
            response = await client.messages.create(
                model=self.model,
                max_tokens=settings.agent.max_tokens_planner,
                system=system,
                messages=messages,
            )
            raw = extract_text(response)
            last_raw = raw

            try:
                output = parse_planner_output(raw)
            except (ValidationError, ValueError) as exc:
                error = self._format_error(exc)
                attempts.append(
                    PlannerAttempt(attempt=attempt, ok=False, error=error, raw=raw)
                )
                log.warning(
                    "planner.parse_failed", attempt=attempt, error=error[:400]
                )
                if attempt == max_attempts:
                    break
                # Feed the failure back in so the model repairs its own output.
                messages = [
                    {"role": "user", "content": request_text},
                    {"role": "assistant", "content": raw},
                    {
                        "role": "user",
                        "content": build_retry_prompt(error, raw),
                    },
                ]
                continue

            attempts.append(PlannerAttempt(attempt=attempt, ok=True, raw=raw))
            log.info(
                "planner.ok",
                attempt=attempt,
                workflow_type=output.entities.workflow_type.value,
                items=len(output.entities.items),
                steps=len(output.steps),
            )
            return PlannerResult(output=output, attempts=attempts)

        raise PlannerError(
            f"planner failed to produce valid output after {max_attempts} attempts: "
            f"{attempts[-1].error if attempts else 'no attempts'}",
            attempts=len(attempts),
            last_raw=last_raw,
        )

    @staticmethod
    def _format_error(exc: Exception) -> str:
        if isinstance(exc, ValidationError):
            lines = [
                f"  - {'.'.join(str(p) for p in e['loc'])}: {e['msg']}"
                for e in exc.errors()
            ]
            return "Schema validation failed:\n" + "\n".join(lines)
        return str(exc)


async def plan_request(request_text: str) -> PlannerResult:
    """Module-level convenience used by the orchestrator's create_request node."""
    try:
        return await Planner().plan(request_text)
    except LLMNotConfiguredError:
        raise
