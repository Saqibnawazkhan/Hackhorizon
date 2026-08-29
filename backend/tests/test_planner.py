"""Planner tests that do not touch the network.

The Claude call is stubbed, so these prove the parts we own: JSON salvage,
Pydantic validation, and the re-prompt-with-the-error retry loop.
"""
from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from app.agent.planner.planner import (
    Planner,
    PlannerError,
    parse_planner_output,
)
from app.schemas.enums import WorkflowType

VALID = {
    "entities": {
        "items": [{"name": "laptops", "quantity": 50, "unit": "units",
                   "specification": None, "category_hint": "IT hardware"}],
        "budget": 10000000,
        "currency": "PKR",
        "workflow_type": "procurement",
        "approver": None,
        "notes": None,
    },
    "steps": [
        {"order": i, "name": n, "title": t, "description": d, "tool_name": tool}
        for i, (n, t, d, tool) in enumerate(
            [
                ("create_request", "Create request", "Record it.", None),
                ("fetch_quotes", "Fetch quotes", "Read catalogs.", "catalog_query"),
                ("budget_filter", "Filter by budget", "Drop over-budget.", None),
                ("score_rank", "Score and rank", "Weighted compare.", None),
                ("select_best", "Select best option", "Pick winner.", None),
                ("generate_po", "Generate PO", "Build PO.", "po_generator"),
                ("validate_po", "Validate PO", "Check it.", None),
                ("route_approval", "Route for approval", "Send it.", "notification"),
            ],
            start=1,
        )
    ],
    "summary": "Purchase 50 laptops under PKR 10,000,000.",
}


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------
def test_parses_clean_json():
    out = parse_planner_output(json.dumps(VALID))
    assert out.entities.workflow_type is WorkflowType.PROCUREMENT
    assert out.entities.items[0].quantity == 50
    assert out.entities.budget == 10000000
    assert len(out.steps) == 8


def test_strips_markdown_code_fence():
    fenced = "```json\n" + json.dumps(VALID) + "\n```"
    assert parse_planner_output(fenced).entities.currency == "PKR"


def test_salvages_json_wrapped_in_prose():
    noisy = "Here is the plan:\n" + json.dumps(VALID) + "\nHope that helps!"
    assert parse_planner_output(noisy).summary.startswith("Purchase 50 laptops")


def test_rejects_non_json():
    with pytest.raises(ValueError, match="not valid JSON"):
        parse_planner_output("I cannot help with that.")


def test_rejects_zero_quantity():
    bad = json.loads(json.dumps(VALID))
    bad["entities"]["items"][0]["quantity"] = 0
    with pytest.raises(ValidationError):
        parse_planner_output(json.dumps(bad))


def test_rejects_unsupported_currency():
    bad = json.loads(json.dumps(VALID))
    bad["entities"]["currency"] = "XYZ"
    with pytest.raises(ValidationError):
        parse_planner_output(json.dumps(bad))


def test_rejects_gapped_step_numbering():
    bad = json.loads(json.dumps(VALID))
    bad["steps"][3]["order"] = 9
    with pytest.raises(ValidationError, match="numbered 1..N"):
        parse_planner_output(json.dumps(bad))


def test_rejects_missing_workflow_type():
    """workflow_type has no default -- the planner MUST decide."""
    bad = json.loads(json.dumps(VALID))
    del bad["entities"]["workflow_type"]
    with pytest.raises(ValidationError):
        parse_planner_output(json.dumps(bad))


def test_multi_item_flag():
    multi = json.loads(json.dumps(VALID))
    multi["entities"]["items"] = [
        {"name": "laptops", "quantity": 50, "unit": None,
         "specification": None, "category_hint": None},
        {"name": "CPU kits", "quantity": 20, "unit": None,
         "specification": "Intel i7", "category_hint": None},
        {"name": "docking kits", "quantity": 60, "unit": None,
         "specification": "USB-C", "category_hint": None},
    ]
    out = parse_planner_output(json.dumps(multi))
    assert out.entities.is_multi_item is True
    assert out.entities.total_quantity == 130


# --------------------------------------------------------------------------
# Retry loop
# --------------------------------------------------------------------------
class _StubMessages:
    def __init__(self, replies: list[str]) -> None:
        self.replies = list(replies)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        text = self.replies.pop(0)

        class _Block:
            type = "text"

            def __init__(self, t: str) -> None:
                self.text = t

        class _Msg:
            def __init__(self, t: str) -> None:
                self.content = [_Block(t)]

        return _Msg(text)


class _StubClient:
    def __init__(self, replies: list[str]) -> None:
        self.messages = _StubMessages(replies)


@pytest.fixture
def stub_client(monkeypatch):
    def _install(replies: list[str]) -> _StubClient:
        client = _StubClient(replies)
        monkeypatch.setattr(
            "app.agent.planner.planner.get_async_client", lambda: client
        )
        return client

    return _install


@pytest.mark.asyncio
async def test_succeeds_first_attempt(stub_client):
    client = stub_client([json.dumps(VALID)])
    result = await Planner().plan("Buy 50 laptops under PKR 10 million")

    assert result.attempt_count == 1
    assert result.self_corrected is False
    assert result.output.entities.workflow_type is WorkflowType.PROCUREMENT
    assert len(client.messages.calls) == 1


@pytest.mark.asyncio
async def test_retries_with_validation_error_appended(stub_client):
    """A malformed first reply must be repaired, not fatal."""
    bad = json.loads(json.dumps(VALID))
    bad["entities"]["items"][0]["quantity"] = -5
    client = stub_client([json.dumps(bad), json.dumps(VALID)])

    result = await Planner().plan("Buy 50 laptops")

    assert result.attempt_count == 2
    assert result.self_corrected is True
    assert result.attempts[0].ok is False
    assert result.attempts[1].ok is True

    # The retry must actually carry the validation error back to the model.
    retry_messages = client.messages.calls[1]["messages"]
    retry_text = retry_messages[-1]["content"]
    assert "Validation error" in retry_text
    assert "quantity" in retry_text


@pytest.mark.asyncio
async def test_gives_up_after_max_attempts(stub_client):
    stub_client(["not json"] * 3)
    with pytest.raises(PlannerError) as exc:
        await Planner().plan("Buy 50 laptops")
    assert exc.value.attempts == 3


@pytest.mark.asyncio
async def test_recovers_from_prose_then_valid(stub_client):
    client = stub_client(["Sure! Here you go.", json.dumps(VALID)])
    result = await Planner().plan("Buy 50 laptops")
    assert result.attempt_count == 2
    assert len(client.messages.calls) == 2
