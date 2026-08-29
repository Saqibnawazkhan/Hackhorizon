"""Planner I/O -- the strict-JSON parse targets for the Claude reasoning core.

The planner receives free text ONLY. It must infer ``workflow_type`` itself;
the client never sends a hint. That inference is the generalizability proof,
so it is modelled as a required field with no default.

On a validation failure the orchestrator re-prompts Claude with the Pydantic
error appended (``settings.agent.planner_max_parse_attempts`` times) -- see
``app/agent/planner/planner.py``.
"""
from __future__ import annotations

from decimal import Decimal

from pydantic import Field, field_serializer, field_validator, model_validator

from app.core.config import settings
from app.schemas.common import AppModel
from app.schemas.enums import WorkflowType


class RequestItem(AppModel):
    """One line item extracted from the request text."""

    name: str = Field(..., min_length=1, max_length=200, description="Item as the user said it, e.g. 'laptops'.")
    quantity: int = Field(..., gt=0, description="Units requested.")
    unit: str | None = Field(None, max_length=32, description="e.g. 'units', 'kits'. Optional.")
    specification: str | None = Field(
        None,
        max_length=500,
        description="Any qualifier the user gave, e.g. 'Intel i7' or 'USB-C'.",
    )
    category_hint: str | None = Field(
        None, max_length=100, description="Coarse category to help catalog matching."
    )
    # Reimbursement claims carry a per-line amount and receipt status;
    # procurement lines do not (the vendor supplies the price). Optional so one
    # model serves both workflow types.
    amount: Decimal | None = Field(
        None, ge=0, description="Claimed amount for this line (reimbursement)."
    )
    receipt: bool | None = Field(
        None, description="Whether a receipt was provided for this line."
    )

    @field_serializer("amount")
    def _ser_amount(self, v: Decimal | None) -> float | None:
        return None if v is None else float(v)


class PlannedStep(AppModel):
    """One node the agent intends to execute, shown on screen 3a before it runs."""

    order: int = Field(..., ge=1)
    name: str = Field(..., min_length=1, max_length=100, description="Node id, e.g. 'fetch_quotes'.")
    title: str = Field(..., min_length=1, max_length=140, description="Human label for the stepper.")
    description: str = Field(..., min_length=1, max_length=400, description="What this step will do, in plain language.")
    tool_name: str | None = Field(
        None, description="Registry key of the tool this step invokes, if any."
    )


class PlannerEntities(AppModel):
    """Everything the planner extracted from the request text."""

    items: list[RequestItem] = Field(..., min_length=1)
    budget: Decimal | None = Field(
        None, gt=0, description="Total budget ceiling. None when the user gave none."
    )
    currency: str = Field(
        default_factory=lambda: settings.default_currency, min_length=3, max_length=3
    )
    workflow_type: WorkflowType = Field(
        ..., description="Inferred from the text alone. No client hint is accepted."
    )
    approver: str | None = Field(
        None, max_length=140, description="Named approver if the user specified one."
    )
    notes: str | None = Field(None, max_length=1000)

    @field_serializer("budget")
    def _ser_budget(self, v: Decimal | None) -> float | None:
        """Emit budget as a number, not a string.

        Pydantic renders Decimal as a string under ``mode="json"``. That value
        is persisted in workflows.entities_json and served back to the client,
        where it collided with the float used at the top level of the same
        response. Clients should never have to guess a field's type.
        """
        return None if v is None else float(v)

    @field_validator("currency")
    @classmethod
    def _known_currency(cls, v: str) -> str:
        v = v.upper()
        if v not in settings.supported_currencies:
            raise ValueError(
                f"currency {v!r} is not supported; expected one of "
                f"{settings.supported_currencies}"
            )
        return v

    @property
    def is_multi_item(self) -> bool:
        """Drives the MODE A / MODE B scoring-strategy selection."""
        return len(self.items) > 1

    @property
    def total_quantity(self) -> int:
        return sum(i.quantity for i in self.items)


class PlannerOutput(AppModel):
    """The complete, strict-JSON planner response."""

    entities: PlannerEntities
    steps: list[PlannedStep] = Field(..., min_length=1)
    summary: str = Field(
        ...,
        min_length=1,
        max_length=500,
        description="One-sentence restatement shown in the chat bubble on 2a.",
    )

    @model_validator(mode="after")
    def _steps_ordered_contiguously(self) -> PlannerOutput:
        orders = [s.order for s in self.steps]
        if orders != list(range(1, len(orders) + 1)):
            raise ValueError(
                f"steps must be numbered 1..N with no gaps or duplicates; got {orders}"
            )
        return self


class PlannerFailure(AppModel):
    """Recorded when the planner never produced valid JSON."""

    attempts: int
    last_error: str
    raw_output: str | None = None


class JustificationRequest(AppModel):
    """Input to the SEPARATE Claude call that narrates the scoring maths.

    The numbers are computed in plain Python first. This call only turns them
    into prose -- it never decides anything.
    """

    workflow_type: WorkflowType
    currency: str
    budget: Decimal | None
    decision_facts: dict = Field(
        ..., description="Pre-computed scoring facts. The LLM may not add to these."
    )


class JustificationResponse(AppModel):
    """Human-readable justification attached to every autonomous decision."""

    headline: str = Field(..., max_length=200, description="e.g. 'Selected TechSupplies Ltd'.")
    body: str = Field(..., max_length=1200, description="Plain-language reasoning.")
    caveats: list[str] = Field(
        default_factory=list,
        description="Surfaced warnings, e.g. 'New vendor -- no fulfilment history'.",
    )
