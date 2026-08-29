"""The graph state carried between nodes.

Kept JSON-serialisable throughout: LangGraph checkpoints it to Postgres after
every node, and an ``interrupt()`` at route_approval may sit in that
checkpoint for hours before a human resumes it. ORM objects and Decimals do
not survive that round trip, so money is carried as strings and rows as ids.
"""
from __future__ import annotations

from typing import Annotated, Any, TypedDict


def _last(_current: Any, incoming: Any) -> Any:
    """Reducer: last write wins. Explicit so re-entering a node overwrites."""
    return incoming


def _append(current: list | None, incoming: list | None) -> list:
    """Reducer: accumulate. Used for the trace, which must never lose entries."""
    return [*(current or []), *(incoming or [])]


class AgentState(TypedDict, total=False):
    # -- identity ------------------------------------------------------
    workflow_id: str
    org_id: str | None
    requester_id: str
    workflow_type: str
    template_name: str

    # -- request -------------------------------------------------------
    request_text: str
    currency: str
    budget: str | None                     # Decimal as string
    items: list[dict[str, Any]]            # [{name, quantity, unit, ...}]
    approver: str | None

    # -- execution -----------------------------------------------------
    current_node: Annotated[str | None, _last]
    status: Annotated[str, _last]
    # name -> {id, order, title, tool_name}, loaded once at launch. The plan is
    # known before execution starts, so nothing needs to read a step row back
    # just to learn its own title.
    steps_meta: dict[str, dict[str, Any]]
    trace: Annotated[list[dict[str, Any]], _append]

    # -- quoting and scoring -------------------------------------------
    offers: list[dict[str, Any]]           # serialised VendorOffer
    quote_ids: list[str]
    qualifying_vendor_ids: list[str]
    comparison: dict[str, Any] | None      # serialised comparison result
    selected_quote_id: str | None
    selected_vendor_name: str | None
    justification: str | None
    caveats: list[str]

    # -- purchase order ------------------------------------------------
    purchase_order_id: str | None
    po_number: str | None
    pdf_path: str | None
    generation_attempt: Annotated[int, _last]

    # -- validation / self-correction ----------------------------------
    validation: dict[str, Any] | None
    validation_passed: Annotated[bool, _last]
    self_correction_attempts: Annotated[int, _last]
    max_self_correction_attempts: int

    # -- reimbursement -------------------------------------------------
    policy_rules: list[dict[str, Any]]
    policy_results: list[dict[str, Any]]
    payable_total: str | None

    # -- human in the loop ---------------------------------------------
    approval_id: str | None
    approval_decision: str | None
    approval_comment: str | None

    # -- terminal ------------------------------------------------------
    escalated: bool
    escalation_reason: str | None
    error: str | None


def initial_state(
    *,
    workflow_id: str,
    org_id: str | None,
    requester_id: str,
    workflow_type: str,
    template_name: str,
    request_text: str,
    currency: str,
    budget: str | None,
    items: list[dict[str, Any]],
    approver: str | None,
    max_self_correction_attempts: int,
) -> AgentState:
    return AgentState(
        workflow_id=workflow_id,
        org_id=org_id,
        requester_id=requester_id,
        workflow_type=workflow_type,
        template_name=template_name,
        request_text=request_text,
        currency=currency,
        budget=budget,
        items=items,
        approver=approver,
        current_node=None,
        status="running",
        steps_meta={},
        trace=[],
        offers=[],
        quote_ids=[],
        qualifying_vendor_ids=[],
        comparison=None,
        selected_quote_id=None,
        selected_vendor_name=None,
        justification=None,
        caveats=[],
        purchase_order_id=None,
        po_number=None,
        pdf_path=None,
        generation_attempt=0,
        validation=None,
        validation_passed=False,
        self_correction_attempts=0,
        max_self_correction_attempts=max_self_correction_attempts,
        policy_rules=[],
        policy_results=[],
        payable_total=None,
        approval_id=None,
        approval_decision=None,
        approval_comment=None,
        escalated=False,
        escalation_reason=None,
        error=None,
    )
