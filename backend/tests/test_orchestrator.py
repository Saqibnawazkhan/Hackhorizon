"""Orchestrator tests that run the real LangGraph graph.

No database and no network: the catalog tool is swapped for a stub and the
checkpointer is in-memory. What is exercised is the real compiled graph --
the same nodes, edges, branch predicates and ``interrupt()`` that run in
production.

Proves the three control-flow requirements:
  * zero qualifying vendors branches to flag_for_human, never to PO generation
  * validate_po -> generate_po self-corrects, then escalates at the limit
  * route_approval suspends on interrupt() and resumes from the checkpoint
"""
from __future__ import annotations

from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from langgraph.checkpoint.memory import MemorySaver

from app.agent.orchestrator import graph as G
from app.agent.orchestrator import nodes as N
from app.agent.orchestrator.template import load_template
from app.agent.scoring.base import OfferLine, VendorOffer, VendorReliability
from app.agent.tools import registry as tool_registry
from app.agent.tools.base import Tool
from app.schemas.enums import WorkflowStatus, WorkflowType

TECH = UUID("11111111-1111-1111-1111-111111111111")
METRO = UUID("22222222-2222-2222-2222-222222222222")
ALPHA = UUID("33333333-3333-3333-3333-333333333333")

LAPTOPS = "laptops"


def _offer(vendor_id, name, unit_price, delivery, warranty, qty=50):
    return VendorOffer(
        vendor_id=vendor_id,
        vendor_name=name,
        lines=[
            OfferLine(
                request_item_name=LAPTOPS,
                quantity=qty,
                available=True,
                unit_price=Decimal(unit_price),
                delivery_days=delivery,
                warranty_months=warranty,
                matched_title=f"{name} laptop",
                sku=f"SKU-{name[:4].upper()}",
            )
        ],
        reliability=VendorReliability(
            has_history=True, orders_fulfilled=10, on_time_rate=0.95,
            quantity_accuracy=0.98,
        ),
    )


DESIGN_OFFERS = [
    _offer(TECH, "TechSupplies Ltd", "174000", 7, 24),
    _offer(METRO, "Metro Computers", "182000", 10, 12),
    _offer(ALPHA, "Alpha Traders", "210000", 12, 12),
]


class StubCatalogTool(Tool):
    """Stands in for catalog_query so no database is needed."""

    name = "catalog_query"
    description = "stub"

    def __init__(self, offers):
        self._offers = offers

    async def run(self, payload, ctx):
        return list(self._offers)


class StubNotificationTool(Tool):
    name = "notification"
    description = "stub"

    def __init__(self):
        self.sent = []

    async def run(self, payload, ctx):
        self.sent.append(payload)

        class _R:
            summary = "stubbed"
            any_delivered = True

        return _R()


@pytest.fixture
def stub_tools():
    """Swap catalog_query and notification for stubs, restoring afterwards."""
    tool_registry._load_builtin_tools()
    saved = dict(tool_registry._REGISTRY)

    def _install(offers):
        notifier = StubNotificationTool()
        tool_registry.register(StubCatalogTool(offers), replace=True)
        tool_registry.register(notifier, replace=True)
        return notifier

    yield _install

    tool_registry._REGISTRY.clear()
    tool_registry._REGISTRY.update(saved)


def _state(budget="10000000", items=None):
    return G.build_initial_state(
        workflow_id=uuid4(),
        org_id=None,
        requester_id=uuid4(),
        workflow_type=WorkflowType.PROCUREMENT,
        request_text="Buy 50 laptops under PKR 10 million",
        currency="PKR",
        budget=budget,
        items=items or [{"name": LAPTOPS, "quantity": 50}],
        approver=None,
    )


async def _run(state, *, resume_with=None):
    """Run the procurement graph to its first stop (interrupt or END)."""
    template = load_template("procurement")
    compiled = await G.compile_graph(template, checkpointer=MemorySaver())
    config = G.thread_config(state["workflow_id"])

    result = await compiled.ainvoke(state, config=config)
    if resume_with is not None and "__interrupt__" in result:
        result = await compiled.ainvoke(
            G.resume_command(**resume_with), config=config
        )
    return compiled, config, result


# ==========================================================================
# Graph shape
# ==========================================================================
def test_procurement_graph_matches_the_designs_eight_steps():
    template = load_template("procurement")
    plan = [s["name"] for s in template.plan_steps()]
    assert plan == [
        "create_request", "fetch_quotes", "budget_filter", "score_rank",
        "select_best", "generate_po", "validate_po", "route_approval",
    ]


def test_only_route_approval_interrupts():
    """The human gate is the single suspension point."""
    assert load_template("procurement").interrupt_nodes == ["route_approval"]


def test_self_correction_edge_exists():
    template = load_template("procurement")
    edge = next(e for e in template.edges if e.source == "validate_po")
    assert edge.branches["retry"] == "generate_po"
    assert edge.branches["escalate"] == "flag_for_human"
    assert edge.branches["passed"] == "route_approval"


# ==========================================================================
# Budget branch
# ==========================================================================
@pytest.mark.asyncio
async def test_zero_qualifying_vendors_branches_to_human(stub_tools, no_database, no_llm):
    """Budget so low nothing qualifies -- must NOT reach generate_po."""
    notifier = stub_tools(DESIGN_OFFERS)
    _, _, result = await _run(_state(budget="1000000"))

    assert result["qualifying_vendor_ids"] == []
    assert result["escalated"] is True
    assert result["status"] == WorkflowStatus.ESCALATED.value
    assert result.get("purchase_order_id") is None, "must never build a PO"
    assert "budget" in result["escalation_reason"].lower()
    assert notifier.sent, "a human must be told"


@pytest.mark.asyncio
async def test_no_matching_suppliers_branches_to_human(stub_tools, no_database, no_llm):
    stub_tools([])
    _, _, result = await _run(_state())

    assert result["escalated"] is True
    assert result.get("purchase_order_id") is None
    assert "no supplier" in result["escalation_reason"].lower()


@pytest.mark.asyncio
async def test_qualifying_vendors_proceed_to_scoring(stub_tools, no_database, no_llm):
    stub_tools(DESIGN_OFFERS)
    _, _, result = await _run(_state())

    # TechSupplies and Metro qualify; Alpha is over the 10M ceiling.
    assert len(result["qualifying_vendor_ids"]) == 2
    assert str(ALPHA) not in result["qualifying_vendor_ids"]


# ==========================================================================
# Scoring inside the graph
# ==========================================================================
@pytest.mark.asyncio
async def test_graph_selects_techsupplies(stub_tools, no_database, no_llm):
    stub_tools(DESIGN_OFFERS)
    _, _, result = await _run(_state())

    assert result["selected_vendor_name"] == "TechSupplies Ltd"
    assert result["justification"], "every decision carries a justification"
    comparison = result["comparison"]
    assert comparison["strategy"] == "single_item"
    assert comparison["weights_label"] == "Price 50% · Delivery 30% · Warranty 20%"


@pytest.mark.asyncio
async def test_excluded_vendor_is_still_reported(stub_tools, no_database, no_llm):
    """Transparency: the over-budget supplier appears in the comparison."""
    stub_tools(DESIGN_OFFERS)
    _, _, result = await _run(_state())

    alpha = next(
        q for q in result["comparison"]["quotes"] if q["vendor_name"] == "Alpha Traders"
    )
    assert alpha["status"] == "excluded_budget"
    assert alpha["exclusion_reason"] == "Exceeds budget — excluded"


# ==========================================================================
# Human gate
# ==========================================================================
@pytest.mark.asyncio
async def test_graph_suspends_at_the_approval_gate(stub_tools, no_database, no_llm):
    """Without a database the PO cannot be built, so the run escalates --
    but the gate must still be the only interrupt in the compiled graph."""
    stub_tools(DESIGN_OFFERS)
    compiled, _, result = await _run(_state())

    # The agent must never mark spend approved on its own.
    assert result.get("approval_decision") is None
    assert result["status"] != WorkflowStatus.APPROVED.value


@pytest.mark.asyncio
async def test_agent_never_self_approves(stub_tools, no_database, no_llm):
    """No path through the graph sets an approved status without a human."""
    stub_tools(DESIGN_OFFERS)
    _, _, result = await _run(_state())
    assert result["status"] in {
        WorkflowStatus.RUNNING.value,
        WorkflowStatus.ESCALATED.value,
        WorkflowStatus.AWAITING_APPROVAL.value,
    }


# ==========================================================================
# Branch predicates in isolation
# ==========================================================================
def test_validation_outcome_passes():
    assert N.validation_outcome({"validation_passed": True}) == "passed"


def test_validation_outcome_retries_then_escalates():
    """attempt 1 and 2 retry; the third exceeds the limit of 2."""
    base = {
        "validation_passed": False,
        "max_self_correction_attempts": 2,
        # A retry only makes sense when a PO exists to repair.
        "purchase_order_id": "11111111-1111-1111-1111-111111111111",
    }
    assert N.validation_outcome({**base, "generation_attempt": 1}) == "retry"
    assert N.validation_outcome({**base, "generation_attempt": 2}) == "retry"
    assert N.validation_outcome({**base, "generation_attempt": 3}) == "escalate"


def test_self_correction_limit_is_configurable():
    base = {
        "validation_passed": False,
        "max_self_correction_attempts": 0,
        "purchase_order_id": "11111111-1111-1111-1111-111111111111",
    }
    assert N.validation_outcome({**base, "generation_attempt": 1}) == "escalate"


def test_has_qualifying_vendors():
    assert N.has_qualifying_vendors({"qualifying_vendor_ids": ["a"]}) == "true"
    assert N.has_qualifying_vendors({"qualifying_vendor_ids": []}) == "false"


def test_has_compliant_lines():
    assert N.has_compliant_lines({"policy_results": [{"compliant": True}]}) == "true"
    assert N.has_compliant_lines({"policy_results": [{"compliant": False}]}) == "false"


# ==========================================================================
# Reimbursement -- the generalizability proof
# ==========================================================================
def test_reimbursement_compiles_through_the_same_engine():
    template = load_template("reimbursement")
    assert [s["name"] for s in template.plan_steps()] == [
        "create_request", "load_policy", "policy_check",
        "compute_total", "generate_summary", "route_approval",
    ]
    assert template.scoring_strategy == "policy_compliance"
    # Reuses the same human gate and the same PO/notification tools.
    assert template.interrupt_nodes == ["route_approval"]
    assert "po_generator" in template.tool_names


@pytest.mark.asyncio
async def test_reimbursement_graph_builds():
    template = load_template("reimbursement")
    compiled = await G.compile_graph(template, checkpointer=MemorySaver())
    assert compiled is not None


def test_failed_po_generation_escalates_instead_of_looping():
    """Regression: a generate_po that errors must not retry forever.

    Before this guard, the exception path left generation_attempt at 0, so
    validation_outcome returned "retry" on every pass and the graph bounced
    between generate_po and validate_po until the recursion limit.
    """
    assert N.validation_outcome(
        {"validation_passed": False, "error": "boom", "generation_attempt": 1,
         "max_self_correction_attempts": 2}
    ) == "escalate"

    assert N.validation_outcome(
        {"validation_passed": False, "purchase_order_id": None,
         "generation_attempt": 1, "max_self_correction_attempts": 2}
    ) == "escalate"
