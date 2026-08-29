"""Node handlers and branch predicates.

Handlers are looked up by the ``handler`` key in a workflow template, so the
graph builder never imports one by name. Adding a node type is: write a
function, decorate it with ``@node("my_handler")``, reference it from YAML.

Every handler:
  * marks its step RUNNING, then COMPLETED or FAILED
  * emits the matching WebSocket event
  * returns a partial ``AgentState`` -- LangGraph merges it and checkpoints

A handler must not raise for an ordinary business outcome (no vendors, failed
validation). Those are state, expressed through branch predicates. Raising is
reserved for genuine faults, and even then the runner records the failure and
escalates rather than letting the workflow crash.
"""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Awaitable, Callable
from uuid import UUID

import structlog
from langgraph.types import interrupt
from sqlalchemy import Integer, case as sa_case, cast as sa_cast, func, update as sa_update

from app.db.models import Step, Workflow

from app.agent.orchestrator.events import emit
from app.agent.orchestrator.state import AgentState
from app.agent.scoring import registry as scoring_registry
from app.agent.scoring.base import (
    OfferLine,
    ScoringContext,
    VendorOffer,
    VendorReliability,
)
from app.agent.tools import registry as tool_registry
from app.agent.tools.base import ToolContext, ToolResult
from app.agent.tools.catalog_query import CatalogQueryPayload
from app.agent.tools.notification import NotificationPayload
from app.agent.tools.po_generator import POGeneratorPayload, POLine
from app.agent.validation.validator import ValidationTarget, Validator
from app.core.config import settings
from app.db.session import session_scope
from app.repositories.device_repo import DeviceRepository
from app.repositories.notification_repo import NotificationRepository
from app.repositories.procurement_repo import (
    ApprovalRepository,
    ConfigRepository,
    PurchaseOrderRepository,
    QuoteRepository,
    ValidationRepository,
)
from app.repositories.workflow_repo import (
    StepRepository,
    ToolCallRepository,
    WorkflowRepository,
)
from app.schemas.enums import (
    QuoteStatus,
    StepStatus,
    ToolCallStatus,
    WSEventType,
    WorkflowStatus,
)

log = structlog.get_logger(__name__)

NodeHandler = Callable[[AgentState], Awaitable[dict[str, Any]]]
_HANDLERS: dict[str, NodeHandler] = {}


def node(name: str) -> Callable[[NodeHandler], NodeHandler]:
    def decorator(fn: NodeHandler) -> NodeHandler:
        if name in _HANDLERS:
            raise ValueError(f"node handler {name!r} is already registered")
        _HANDLERS[name] = fn
        return fn

    return decorator


def get_handler(name: str) -> NodeHandler:
    try:
        return _HANDLERS[name]
    except KeyError:
        raise KeyError(
            f"unknown node handler {name!r}; registered: {sorted(_HANDLERS)}"
        ) from None


def available_handlers() -> list[str]:
    return sorted(_HANDLERS)


# ==========================================================================
# Step + tool plumbing
# ==========================================================================
def _step_meta(state: AgentState, name: str) -> dict[str, Any] | None:
    """Step id, order, title and tool, cached in state at launch.

    The plan is known before execution begins, so re-reading a step row just to
    learn its own title was a round trip per transition. On a ~280 ms link that
    was nearly ten seconds of an eight-step run.
    """
    return (state.get("steps_meta") or {}).get(name)


async def _start_step(state: AgentState, name: str) -> UUID | None:
    """Mark a step RUNNING and announce it.

    One statement: UPDATE ... RETURNING, no preceding SELECT.
    """
    workflow_id = UUID(state["workflow_id"])
    if not settings.database_configured:
        return None

    meta = _step_meta(state, name)
    async with session_scope() as session:
        if meta is None:
            # No cached plan (a resumed run, or a step added later) -- fall back
            # to the lookup rather than silently skipping the transition.
            step = await StepRepository(session).by_name(workflow_id, name)
            if step is None:
                return None
            meta = {
                "id": str(step.id),
                "order": step.step_order,
                "title": step.title,
                "tool_name": step.tool_name,
            }

        step_id = UUID(meta["id"])
        await session.execute(
            sa_update(Step)
            .where(Step.id == step_id)
            .values(
                status=StepStatus.RUNNING.value,
                started_at=func.now(),
                error=None,
            )
        )
        await emit(
            workflow_id,
            WSEventType.STEP_STARTED,
            {
                "step_id": str(step_id),
                "step_order": meta["order"],
                "name": name,
                "title": meta["title"],
                "tool_name": meta.get("tool_name"),
            },
            session=session,
        )
        return step_id


async def _finish_step(
    state: AgentState,
    name: str,
    *,
    output: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    """Complete or fail a step in one statement.

    duration_ms is computed in SQL from started_at, so the row never has to be
    read back first.
    """
    workflow_id = UUID(state["workflow_id"])
    if not settings.database_configured:
        return

    meta = _step_meta(state, name)
    async with session_scope() as session:
        if meta is None:
            step = await StepRepository(session).by_name(workflow_id, name)
            if step is None:
                return
            meta = {
                "id": str(step.id),
                "order": step.step_order,
                "title": step.title,
                "tool_name": step.tool_name,
            }

        step_id = UUID(meta["id"])
        duration = sa_case(
            (
                Step.started_at.is_(None),
                None,
            ),
            else_=sa_cast(
                func.extract("epoch", func.now() - Step.started_at) * 1000,
                Integer,
            ),
        )
        values: dict[str, Any] = {
            "completed_at": func.now(),
            "duration_ms": duration,
        }
        if error:
            values |= {"status": StepStatus.FAILED.value, "error": error}
        else:
            values |= {
                "status": StepStatus.COMPLETED.value,
                "output_json": output,
            }

        row = (
            await session.execute(
                sa_update(Step)
                .where(Step.id == step_id)
                .values(**values)
                .returning(Step.duration_ms, Step.retry_count, Step.max_retries)
            )
        ).first()
        duration_ms, retry_count, max_retries = (
            row if row is not None else (None, 0, 3)
        )

        if error:
            await emit(
                workflow_id,
                WSEventType.STEP_FAILED,
                {
                    "step_id": str(step_id),
                    "step_order": meta["order"],
                    "name": name,
                    "error": error,
                    "will_retry": False,
                    "retry_count": retry_count,
                    "max_retries": max_retries,
                },
                session=session,
            )
        else:
            await emit(
                workflow_id,
                WSEventType.STEP_COMPLETED,
                {
                    "step_id": str(step_id),
                    "step_order": meta["order"],
                    "name": name,
                    "duration_ms": duration_ms or 0,
                    "output_summary": (output or {}).get("summary"),
                },
                session=session,
            )


async def _run_tool(
    state: AgentState, step_name: str, tool_name: str, payload: Any
) -> ToolResult:
    """Execute a registered tool, logging every attempt to ``tool_calls``.

    The tool wrapper already guarantees retries and that failures come back as
    values rather than exceptions; this adds the persistence and the live
    events so screens 4a and 4b can show the tool log and the retry state.
    """
    workflow_id = UUID(state["workflow_id"])
    tool = tool_registry.get(tool_name)
    ctx = ToolContext(
        workflow_id=workflow_id,
        org_id=UUID(state["org_id"]) if state.get("org_id") else None,
        currency=state.get("currency", settings.default_currency),
    )

    result = await tool.execute(payload, ctx)

    if settings.database_configured:
        async with session_scope() as session:
            steps = StepRepository(session)
            calls = ToolCallRepository(session)
            meta = _step_meta(state, step_name)
            step = (
                await steps.get(UUID(meta["id"]))
                if meta
                else await steps.by_name(workflow_id, step_name)
            )
            if step is not None:
                for att in result.attempts:
                    await calls.record(
                        workflow_id=workflow_id,
                        step_id=step.id,
                        tool_name=tool_name,
                        status=att.status,
                        attempt=att.attempt,
                        retry_count=max(0, att.attempt - 1),
                        duration_ms=att.duration_ms,
                        error=att.error,
                    )
                if result.retry_count:
                    # Screen 4b: the step visibly enters a retrying state.
                    await steps.mark_retrying(step, result.retry_count)
                    await emit(
                        workflow_id,
                        WSEventType.STEP_RETRYING,
                        {
                            "step_id": str(step.id),
                            "step_order": step.step_order,
                            "name": step.name,
                            "attempt": len(result.attempts),
                            "max_attempts": settings.agent.tool_max_attempts,
                            "delay_seconds": settings.agent.tool_backoff_base_seconds,
                            "reason": result.attempts[0].error or "tool call failed",
                        },
                        session=session,
                    )

    await emit(
        workflow_id,
        WSEventType.TOOL_CALLED,
        {
            "tool_call_id": str(workflow_id),
            "step_id": step_name,
            "tool_name": tool_name,
            "status": result.final_status.value,
            "duration_ms": result.duration_ms,
            "retry_count": result.retry_count,
            "summary": result.error or "ok",
        },
    )
    return result


# ==========================================================================
# Serialisation helpers -- state must stay JSON-safe for checkpointing
# ==========================================================================
def _offer_to_dict(offer: VendorOffer) -> dict[str, Any]:
    return {
        "vendor_id": str(offer.vendor_id),
        "vendor_name": offer.vendor_name,
        "reliability": {
            "has_history": offer.reliability.has_history,
            "orders_fulfilled": offer.reliability.orders_fulfilled,
            "on_time_rate": offer.reliability.on_time_rate,
            "quantity_accuracy": offer.reliability.quantity_accuracy,
            "cancellations": offer.reliability.cancellations,
            "late_deliveries": offer.reliability.late_deliveries,
        },
        "lines": [
            {
                "request_item_name": ln.request_item_name,
                "quantity": ln.quantity,
                "available": ln.available,
                "catalog_item_id": str(ln.catalog_item_id) if ln.catalog_item_id else None,
                "sku": ln.sku,
                "matched_title": ln.matched_title,
                "unit_price": str(ln.unit_price) if ln.unit_price is not None else None,
                "line_total": str(ln.line_total) if ln.line_total is not None else None,
                "delivery_days": ln.delivery_days,
                "warranty_months": ln.warranty_months,
                "stock_on_hand": ln.stock_on_hand,
            }
            for ln in offer.lines
        ],
    }


def _offer_from_dict(data: dict[str, Any]) -> VendorOffer:
    r = data.get("reliability", {})
    return VendorOffer(
        vendor_id=UUID(data["vendor_id"]),
        vendor_name=data["vendor_name"],
        reliability=VendorReliability(
            has_history=r.get("has_history", False),
            orders_fulfilled=r.get("orders_fulfilled", 0),
            on_time_rate=r.get("on_time_rate"),
            quantity_accuracy=r.get("quantity_accuracy"),
            cancellations=r.get("cancellations", 0),
            late_deliveries=r.get("late_deliveries", 0),
        ),
        lines=[
            OfferLine(
                request_item_name=ln["request_item_name"],
                quantity=ln["quantity"],
                available=ln["available"],
                catalog_item_id=UUID(ln["catalog_item_id"]) if ln.get("catalog_item_id") else None,
                sku=ln.get("sku"),
                matched_title=ln.get("matched_title"),
                unit_price=Decimal(ln["unit_price"]) if ln.get("unit_price") else None,
                delivery_days=ln.get("delivery_days"),
                warranty_months=ln.get("warranty_months"),
                stock_on_hand=ln.get("stock_on_hand"),
            )
            for ln in data.get("lines", [])
        ],
    )


def _trace(node_name: str, detail: str, **extra: Any) -> list[dict[str, Any]]:
    return [
        {
            "node": node_name,
            "detail": detail,
            "at": datetime.now(UTC).isoformat(),
            **extra,
        }
    ]


# ==========================================================================
# Procurement nodes
# ==========================================================================
@node("create_request")
async def create_request(state: AgentState) -> dict[str, Any]:
    await _start_step(state, "create_request")
    items = state.get("items", [])
    summary = ", ".join(f"{i['name']} x {i['quantity']}" for i in items)

    if settings.database_configured:
        async with session_scope() as session:
            repo = WorkflowRepository(session)
            workflow = await repo.get(UUID(state["workflow_id"]))
            if workflow is not None:
                await repo.set_status(workflow, WorkflowStatus.RUNNING)

    await _finish_step(state, "create_request", output={"summary": summary})
    return {
        "current_node": "create_request",
        "status": WorkflowStatus.RUNNING.value,
        "trace": _trace("create_request", f"Recorded {len(items)} line item(s)."),
    }


@node("fetch_quotes")
async def fetch_quotes(state: AgentState) -> dict[str, Any]:
    """Read vendor catalogs and FREEZE each vendor's terms onto a quote row."""
    await _start_step(state, "fetch_quotes")
    workflow_id = UUID(state["workflow_id"])

    payload = CatalogQueryPayload(
        items=state.get("items", []),
        org_id=UUID(state["org_id"]) if state.get("org_id") else None,
    )
    result = await _run_tool(state, "fetch_quotes", "catalog_query", payload)

    if not result.ok:
        await _finish_step(state, "fetch_quotes", error=result.error)
        return {
            "current_node": "fetch_quotes",
            "offers": [],
            "error": result.error,
            "trace": _trace("fetch_quotes", f"Catalog query failed: {result.error}"),
        }

    offers: list[VendorOffer] = result.value or []
    quote_ids: list[str] = []

    # Snapshot before scoring. Everything downstream reads these rows, never
    # the live catalog.
    if settings.database_configured and offers:
        async with session_scope() as session:
            quotes = QuoteRepository(session)
            for offer in offers:
                quote = await quotes.snapshot(
                    workflow_id=workflow_id,
                    vendor_id=offer.vendor_id,
                    vendor_name=offer.vendor_name,
                    currency=state.get("currency", settings.default_currency),
                    items_requested=max(len(state.get("items", [])), 1),
                    lines=[
                        {
                            "request_item_name": ln.request_item_name,
                            "quantity": ln.quantity,
                            "available": ln.available,
                            "catalog_item_id": ln.catalog_item_id,
                            "sku": ln.sku,
                            "matched_title": ln.matched_title,
                            "unit_price": ln.unit_price,
                            "line_total": ln.line_total,
                            "delivery_days": ln.delivery_days,
                            "warranty_months": ln.warranty_months,
                            "stock_on_hand": ln.stock_on_hand,
                        }
                        for ln in offer.lines
                    ],
                    reliability_score=(
                        Decimal(str(offer.reliability.star_score))
                        if offer.reliability.star_score is not None
                        else None
                    ),
                    reliability_has_history=offer.reliability.has_history,
                )
                quote_ids.append(str(quote.id))

    await _finish_step(
        state,
        "fetch_quotes",
        output={"summary": f"{len(offers)} supplier(s) quoted"},
    )
    return {
        "current_node": "fetch_quotes",
        "offers": [_offer_to_dict(o) for o in offers],
        "quote_ids": quote_ids,
        "trace": _trace(
            "fetch_quotes", f"Snapshotted {len(offers)} supplier quote(s)."
        ),
    }


@node("budget_filter")
async def budget_filter(state: AgentState) -> dict[str, Any]:
    """Separate qualifying suppliers from those over the ceiling."""
    await _start_step(state, "budget_filter")
    budget = Decimal(state["budget"]) if state.get("budget") else None
    offers = [_offer_from_dict(o) for o in state.get("offers", [])]

    qualifying = [
        o
        for o in offers
        if o.total_amount is not None
        and (budget is None or o.total_amount <= budget)
    ]
    excluded = len(offers) - len(qualifying)

    detail = (
        f"{len(qualifying)} of {len(offers)} supplier(s) within budget"
        + (f"; {excluded} excluded" if excluded else "")
    )
    await _finish_step(state, "budget_filter", output={"summary": detail})
    return {
        "current_node": "budget_filter",
        "qualifying_vendor_ids": [str(o.vendor_id) for o in qualifying],
        "trace": _trace("budget_filter", detail),
    }


@node("score_rank")
async def score_rank(state: AgentState) -> dict[str, Any]:
    """PLAIN PYTHON scoring. No LLM is consulted here."""
    await _start_step(state, "score_rank")
    workflow_id = UUID(state["workflow_id"])
    offers = [_offer_from_dict(o) for o in state.get("offers", [])]

    org_id = UUID(state["org_id"]) if state.get("org_id") else None
    if settings.database_configured:
        async with session_scope() as session:
            weights, _ = await ConfigRepository(session).weights_for(org_id)
    else:
        from app.schemas.admin import ScoringWeights

        s = settings.scoring
        weights = ScoringWeights(
            price=s.weight_price,
            delivery=s.weight_delivery,
            warranty=s.weight_warranty,
            reliability=s.weight_reliability,
        )

    context = ScoringContext(
        workflow_id=workflow_id,
        offers=offers,
        weights=weights,
        currency=state.get("currency", settings.default_currency),
        budget=Decimal(state["budget"]) if state.get("budget") else None,
        line_item_quantities={
            i["name"]: int(i["quantity"]) for i in state.get("items", [])
        },
    )
    strategy = scoring_registry.select(context)
    comparison = strategy.score(context)

    if settings.database_configured:
        async with session_scope() as session:
            await QuoteRepository(session).apply_scores(
                workflow_id,
                [
                    {
                        "vendor_id": q.vendor_id,
                        "status": q.status.value,
                        "exclusion_reason": q.exclusion_reason,
                        "score_total": (
                            Decimal(str(q.score.total)) if q.score else None
                        ),
                        "score_json": (
                            q.score.model_dump(mode="json") if q.score else None
                        ),
                        "confidence_percent": (
                            q.score.confidence.percent if q.score else None
                        ),
                        "missing_fields": (
                            q.score.confidence.missing_fields if q.score else []
                        ),
                    }
                    for q in comparison.quotes
                ],
            )

    payload = comparison.model_dump(mode="json")
    await emit(
        workflow_id,
        WSEventType.COMPARISON_READY,
        {
            "strategy": comparison.strategy.value,
            "selected_vendor_name": next(
                (
                    q.vendor_name
                    for q in comparison.quotes
                    if q.id == comparison.selected_quote_id
                ),
                None,
            ),
            "justification": comparison.justification,
            "quote_count": len(comparison.quotes),
        },
    )
    await _finish_step(
        state,
        "score_rank",
        output={"summary": f"Ranked {len(comparison.quotes)} supplier(s)"},
    )
    return {
        "current_node": "score_rank",
        "comparison": payload,
        "trace": _trace(
            "score_rank",
            f"Scored with {comparison.weights_label}.",
            strategy=comparison.strategy.value,
        ),
    }


@node("select_best")
async def select_best(state: AgentState) -> dict[str, Any]:
    """Record the winner and narrate the decision.

    The maths is already done. This node only picks the recorded winner and
    asks Claude to phrase it. If that call fails, the deterministic
    justification from the scoring engine stands -- a decision is never left
    unexplained.
    """
    await _start_step(state, "select_best")
    comparison = state.get("comparison") or {}
    selected_id = comparison.get("selected_quote_id")
    justification = comparison.get("justification") or ""
    caveats = list(comparison.get("caveats") or [])

    vendor_name = next(
        (
            q["vendor_name"]
            for q in comparison.get("quotes", [])
            if q["id"] == selected_id
        ),
        None,
    )

    narrated = await _narrate(state, comparison)
    if narrated is not None:
        justification = narrated["body"]
        caveats = list({*caveats, *narrated.get("caveats", [])})

    # Persist it. Until now the justification existed only in graph state, in
    # a WebSocket frame and in the push body -- so the approver, who is the
    # one person who most needs the agent's reasoning, could not be shown it.
    if justification and settings.database_configured:
        async with session_scope() as session:
            await session.execute(
                sa_update(Workflow)
                .where(Workflow.id == UUID(state["workflow_id"]))
                .values(justification=justification)
            )

    await _finish_step(
        state,
        "select_best",
        output={"summary": f"Selected {vendor_name}" if vendor_name else "No selection"},
    )
    return {
        "current_node": "select_best",
        "selected_quote_id": selected_id,
        "selected_vendor_name": vendor_name,
        "justification": justification,
        "caveats": caveats,
        "trace": _trace("select_best", justification or "No supplier selected."),
    }


async def _narrate(state: AgentState, comparison: dict) -> dict | None:
    """Ask Claude to phrase the decision. Numbers are never re-derived here."""
    import json

    from app.agent.llm import LLMNotConfiguredError, extract_text, get_async_client
    from app.agent.planner.prompts import JUSTIFICATION_SYSTEM

    try:
        client = get_async_client()
    except LLMNotConfiguredError:
        return None

    facts = {
        "currency": comparison.get("currency"),
        "budget": comparison.get("budget"),
        "weights_label": comparison.get("weights_label"),
        "deterministic_justification": comparison.get("justification"),
        "caveats": comparison.get("caveats"),
        "quotes": [
            {
                "vendor": q["vendor_name"],
                "total": q.get("total_amount"),
                "delivery_days": q.get("delivery_days"),
                "warranty_months": q.get("warranty_months"),
                "score": (q.get("score") or {}).get("total"),
                "confidence": ((q.get("score") or {}).get("confidence") or {}).get(
                    "percent"
                ),
                "coverage": q.get("coverage_label"),
                "status": q.get("status"),
                "excluded_because": q.get("exclusion_reason"),
                "reliability": (q.get("reliability") or {}).get("display"),
            }
            for q in comparison.get("quotes", [])
        ],
        "scenarios": comparison.get("scenarios"),
    }

    try:
        response = await client.messages.create(
            model=settings.agent.model,
            max_tokens=settings.agent.max_tokens_justification,
            system=JUSTIFICATION_SYSTEM,
            messages=[{"role": "user", "content": json.dumps(facts, default=str)}],
        )
        text = extract_text(response)
        start, end = text.find("{"), text.rfind("}")
        return json.loads(text[start : end + 1]) if start != -1 else None
    except Exception as exc:  # noqa: BLE001 - narration is best-effort
        log.warning("justification.failed", error=str(exc))
        return None


@node("generate_po")
async def generate_po(state: AgentState) -> dict[str, Any]:
    """Build the PO from the quote SNAPSHOT and render its PDF."""
    await _start_step(state, "generate_po")
    workflow_id = UUID(state["workflow_id"])
    attempt = int(state.get("generation_attempt", 0)) + 1

    if not settings.database_configured:
        await _finish_step(state, "generate_po", error="database not configured")
        return {
            "current_node": "generate_po",
            "generation_attempt": attempt,
            "error": "database not configured",
        }

    async with session_scope() as session:
        workflows = WorkflowRepository(session)
        quotes = QuoteRepository(session)
        pos = PurchaseOrderRepository(session)

        workflow = await workflows.get_or_raise(workflow_id)
        quote = await quotes.selected(workflow_id)
        if quote is None:
            await _finish_step(state, "generate_po", error="no selected quote")
            return {
                "current_node": "generate_po",
                "generation_attempt": attempt,
                "error": "no selected quote",
            }

        po = await pos.create_from_quote(
            workflow=workflow, quote=quote, attempt=attempt
        )
        po_payload = POGeneratorPayload(
            po_number=po.po_number,
            vendor_name=quote.vendor_name,
            currency=po.currency,
            lines=[
                POLine(
                    description=li.description,
                    sku=li.sku,
                    quantity=li.quantity,
                    unit_price=li.unit_price,
                    line_total=li.line_total,
                )
                for li in po.line_items
            ],
            subtotal=po.subtotal,
            tax=po.tax,
            total_amount=po.total_amount,
            delivery_days=po.delivery_days,
            expected_delivery_date=po.expected_delivery_date,
            warranty_months=po.warranty_months,
        )
        po_id, po_number = str(po.id), po.po_number

    result = await _run_tool(state, "generate_po", "po_generator", po_payload)
    pdf_path = result.value.object_path if result.ok and result.value else None

    if pdf_path and settings.database_configured:
        async with session_scope() as session:
            pos = PurchaseOrderRepository(session)
            po = await pos.get(UUID(po_id))
            if po is not None:
                po.pdf_path = pdf_path

    await _finish_step(
        state, "generate_po", output={"summary": f"{po_number} (attempt {attempt})"}
    )
    return {
        "current_node": "generate_po",
        "purchase_order_id": po_id,
        "po_number": po_number,
        "pdf_path": pdf_path,
        "generation_attempt": attempt,
        "trace": _trace("generate_po", f"Generated {po_number} (attempt {attempt})."),
    }


@node("validate_po")
async def validate_po(state: AgentState) -> dict[str, Any]:
    """Deterministic checks against the quote snapshot. Screens 6a / 6b."""
    await _start_step(state, "validate_po")
    workflow_id = UUID(state["workflow_id"])
    attempt = int(state.get("generation_attempt", 1))
    max_attempts = int(
        state.get("max_self_correction_attempts", settings.agent.max_self_correction_attempts)
    ) + 1

    if not settings.database_configured or not state.get("purchase_order_id"):
        await _finish_step(state, "validate_po", error="no purchase order to validate")
        return {
            "current_node": "validate_po",
            "validation_passed": False,
            "error": "no purchase order to validate",
        }

    async with session_scope() as session:
        pos = PurchaseOrderRepository(session)
        quotes = QuoteRepository(session)
        validations = ValidationRepository(session)

        po = await pos.get_or_raise(UUID(state["purchase_order_id"]))
        quote = await quotes.get_or_raise(po.quote_id)

        target = ValidationTarget(
            workflow_id=workflow_id,
            purchase_order_id=po.id,
            currency=po.currency,
            budget=Decimal(state["budget"]) if state.get("budget") else None,
            po_total=po.total_amount,
            po_subtotal=po.subtotal,
            po_tax=po.tax,
            po_vendor_id=po.vendor_id,
            po_vendor_name=quote.vendor_name,
            po_delivery_days=po.delivery_days,
            po_warranty_months=po.warranty_months,
            po_lines=[
                {
                    "name": li.description,
                    "description": li.description,
                    "quantity": li.quantity,
                    "unit_price": li.unit_price,
                    "line_total": li.line_total,
                }
                for li in po.line_items
            ],
            quote_vendor_id=quote.vendor_id,
            quote_vendor_name=quote.vendor_name,
            quote_total=quote.total_amount,
            quote_delivery_days=quote.delivery_days,
            quote_warranty_months=quote.warranty_months,
            quote_lines=[
                {"name": ln.matched_title or ln.request_item_name,
                 "unit_price": ln.unit_price}
                for ln in quote.lines
            ],
            requested_items=[
                {"name": ln.matched_title or ln.request_item_name,
                 "quantity": ln.quantity}
                for ln in quote.lines
                if ln.available
            ],
            present_fields=frozenset(
                f
                for f, present in (
                    ("po_number", bool(po.po_number)),
                    ("vendor_name", bool(quote.vendor_name)),
                    ("total_amount", po.total_amount is not None),
                    ("currency", bool(po.currency)),
                )
                if present
            ),
        )
        report = Validator().validate(
            target, attempt=attempt, max_attempts=max_attempts
        )
        await validations.record(
            workflow_id=workflow_id,
            purchase_order_id=po.id,
            attempt=attempt,
            max_attempts=max_attempts,
            passed=report.passed,
            checks=[c.model_dump(mode="json") for c in report.checks],
        )

    await emit(
        workflow_id,
        WSEventType.VALIDATION_RESULT,
        {
            "passed": report.passed,
            "attempt": attempt,
            "max_attempts": max_attempts,
            "passed_count": report.passed_count,
            "total_checks": len(report.checks),
            "failed_check_titles": [c.title for c in report.failed_checks],
        },
    )
    await _finish_step(state, "validate_po", output={"summary": report.summary_label})

    return {
        "current_node": "validate_po",
        "validation": report.model_dump(mode="json"),
        "validation_passed": report.passed,
        "trace": _trace("validate_po", report.summary_label),
    }


@node("route_approval")
async def route_approval(state: AgentState) -> dict[str, Any]:
    """Mandatory human gate.

    ``interrupt()`` suspends the graph here and LangGraph checkpoints the
    state. The run resumes only when an authenticated ADMIN posts a decision,
    which is why the agent structurally cannot approve its own spend.
    """
    await _start_step(state, "route_approval")
    workflow_id = UUID(state["workflow_id"])
    approval_id: str | None = None
    approver_tokens: list[str] = []

    if settings.database_configured:
        async with session_scope() as session:
            workflows = WorkflowRepository(session)
            approvals = ApprovalRepository(session)
            workflow = await workflows.get_or_raise(workflow_id)
            approval, created = await approvals.request(
                workflow_id=workflow_id,
                purchase_order_id=(
                    UUID(state["purchase_order_id"])
                    if state.get("purchase_order_id")
                    else None
                ),
                org_id=workflow.org_id,
            )
            approval_id = str(approval.id)

            # Announcing the gate must happen exactly once. LangGraph re-runs
            # a node from the top when the run resumes, so everything here
            # executes again AFTER the decision -- without this guard,
            # approving a purchase order flipped the workflow back to
            # awaiting_approval and notified every admin a second time.
            if created:
                await workflows.set_status(
                    workflow, WorkflowStatus.AWAITING_APPROVAL
                )
                # The gate is the one moment a run genuinely needs to reach
                # somebody who is not looking at the screen.
                devices = DeviceRepository(session)
                approver_tokens = await devices.tokens_for_approvers(
                    workflow.org_id
                )
                # ... and a durable row per approver, so the bell has
                # something to count and the request survives a dismissed
                # push.
                await NotificationRepository(session).fan_out(
                    user_ids=await devices.approver_ids(workflow.org_id),
                    org_id=workflow.org_id,
                    kind="approval_required",
                    title=(
                        "Approval needed: "
                        f"{state.get('po_number') or 'purchase order'}"
                    ),
                    body=state.get("justification")
                    or "A purchase order awaits your decision.",
                    deep_link=f"agentflow://approvals/{approval_id}",
                    workflow_id=workflow_id,
                )

    comparison = state.get("comparison") or {}
    await _run_tool(
        state,
        "route_approval",
        "notification",
        NotificationPayload(
            kind="approval_required",
            title=f"Approval needed: {state.get('po_number') or 'purchase order'}",
            body=state.get("justification") or "A purchase order awaits your decision.",
            fcm_tokens=approver_tokens,
            deep_link=f"agentflow://approvals/{approval_id}" if approval_id else None,
            data={"workflow_id": str(workflow_id), "approval_id": approval_id or ""},
        ),
    )
    await emit(
        workflow_id,
        WSEventType.APPROVAL_REQUIRED,
        {
            "approval_id": approval_id,
            "purchase_order_id": state.get("purchase_order_id"),
            "total_amount": comparison.get("budget"),
            "currency": state.get("currency"),
            "vendor_name": state.get("selected_vendor_name"),
        },
    )

    # Suspend. Everything after this line runs only after a human decides.
    decision = interrupt(
        {
            "reason": "human_approval_required",
            "approval_id": approval_id,
            "workflow_id": str(workflow_id),
            "po_number": state.get("po_number"),
            "vendor_name": state.get("selected_vendor_name"),
            "justification": state.get("justification"),
        }
    )

    outcome = (decision or {}).get("decision", "approved")
    comment = (decision or {}).get("comment")
    status = (
        WorkflowStatus.COMPLETED
        if outcome == "approved"
        else WorkflowStatus.REJECTED
    )

    if settings.database_configured:
        async with session_scope() as session:
            workflows = WorkflowRepository(session)
            workflow = await workflows.get_or_raise(workflow_id)
            await workflows.set_status(workflow, status)

    await _finish_step(
        state, "route_approval", output={"summary": f"Decision: {outcome}"}
    )
    await emit(
        workflow_id,
        WSEventType.WORKFLOW_COMPLETED,
        {"status": status.value, "duration_ms": None, "report_available": True},
    )
    return {
        "current_node": "route_approval",
        "approval_id": approval_id,
        "approval_decision": outcome,
        "approval_comment": comment,
        "status": status.value,
        "trace": _trace("route_approval", f"Human decision: {outcome}."),
    }


@node("flag_for_human")
async def flag_for_human(state: AgentState) -> dict[str, Any]:
    """Escape hatch: no qualifying supplier, or self-correction exhausted."""
    await _start_step(state, "flag_for_human")
    workflow_id = UUID(state["workflow_id"])

    is_reimbursement = state.get("workflow_type") == "reimbursement"

    if is_reimbursement and state.get("policy_results"):
        # Every claim line breached policy -- say which rules, not "no supplier".
        breaches = {
            b
            for r in state.get("policy_results", [])
            for b in (r.get("breaches") or [])
        }
        reason = (
            "No claim line complies with the expense policy: "
            + "; ".join(sorted(breaches))
            if breaches
            else "No claim line complies with the expense policy."
        )
        stage = "policy_check"
    elif is_reimbursement:
        reason = (
            "No expense policy is configured for this organisation, so the "
            "claim cannot be assessed automatically."
        )
        stage = "load_policy"
    elif state.get("qualifying_vendor_ids") == [] and not state.get("validation"):
        reason = (
            "No supplier could meet the budget for this request."
            if state.get("offers")
            else "No supplier in the catalog matches this request."
        )
        stage = "budget_filter"
    elif state.get("validation") is not None:
        failed = [
            c["title"]
            for c in (state.get("validation") or {}).get("checks", [])
            if c.get("outcome") == "failed"
        ]
        reason = (
            "The generated purchase order failed validation after "
            f"{state.get('generation_attempt')} attempt(s): {', '.join(failed)}."
        )
        stage = "validate_po"
    else:
        reason = state.get("error") or "The workflow could not complete automatically."
        stage = "tool_failure"

    escalation_tokens: list[str] = []
    if settings.database_configured:
        async with session_scope() as session:
            workflows = WorkflowRepository(session)
            workflow = await workflows.get_or_raise(workflow_id)
            await workflows.set_status(
                workflow, WorkflowStatus.ESCALATED, reason=reason
            )
            devices = DeviceRepository(session)
            escalation_tokens = await devices.tokens_for_approvers(workflow.org_id)
            # The requester too: an escalation is a request that stopped, and
            # the person who raised it is the one waiting on it.
            recipients = await devices.approver_ids(workflow.org_id)
            if workflow.requester_id:
                escalation_tokens += await devices.tokens_for_user(
                    workflow.requester_id
                )
                recipients.append(workflow.requester_id)
            await NotificationRepository(session).fan_out(
                user_ids=recipients,
                org_id=workflow.org_id,
                kind="workflow_escalated",
                title="AgentFlow needs a human",
                body=reason,
                deep_link=f"agentflow://workflows/{workflow_id}",
                workflow_id=workflow_id,
            )

    await _run_tool(
        state,
        "flag_for_human",
        "notification",
        NotificationPayload(
            kind="workflow_escalated",
            title="AgentFlow needs a human",
            body=reason,
            fcm_tokens=sorted(set(escalation_tokens)),
            deep_link=f"agentflow://workflows/{workflow_id}",
            data={"workflow_id": str(workflow_id)},
        ),
    )
    await emit(
        workflow_id,
        WSEventType.WORKFLOW_ESCALATED,
        {"reason": reason, "stage": stage, "detail": state.get("error")},
    )
    await _finish_step(state, "flag_for_human", output={"summary": reason})

    return {
        "current_node": "flag_for_human",
        "escalated": True,
        "escalation_reason": reason,
        "status": WorkflowStatus.ESCALATED.value,
        "trace": _trace("flag_for_human", reason),
    }


# ==========================================================================
# Reimbursement nodes -- the generalizability proof
# ==========================================================================
@node("load_policy")
async def load_policy(state: AgentState) -> dict[str, Any]:
    await _start_step(state, "load_policy")
    org_id = UUID(state["org_id"]) if state.get("org_id") else None
    rules: list[dict[str, Any]] = []

    if settings.database_configured:
        from app.schemas.enums import WorkflowType

        async with session_scope() as session:
            rows = await ConfigRepository(session).active_policy_rules(
                org_id, WorkflowType.REIMBURSEMENT
            )
            rules = [
                {
                    "id": str(r.id),
                    "name": r.name,
                    "rule_type": r.rule_type,
                    "category": r.category,
                    "numeric_value": str(r.numeric_value) if r.numeric_value else None,
                    "currency": r.currency,
                    "text_value": r.text_value,
                    "message": r.message,
                }
                for r in rows
            ]

    await _finish_step(
        state, "load_policy", output={"summary": f"{len(rules)} active rule(s)"}
    )
    return {
        "current_node": "load_policy",
        "policy_rules": rules,
        "trace": _trace("load_policy", f"Loaded {len(rules)} active policy rule(s)."),
    }


@node("policy_check")
async def policy_check(state: AgentState) -> dict[str, Any]:
    """Test each claim line against the policy. Deterministic, like the
    procurement validator -- a breach is a fact, not a judgement call."""
    await _start_step(state, "policy_check")
    rules = state.get("policy_rules", [])
    results: list[dict[str, Any]] = []
    items = state.get("items", [])

    # The claimant may have given a single total with no breakdown.
    # Assessing invented splits would be worse than saying so: those lines
    # are recorded as unassessed and the caveat reaches the human.
    itemised = any(i.get("amount") for i in items)

    for item in items:
        breaches: list[str] = []
        # A rule applies when its category matches AND, if it names a specific
        # item in text_value, the claim line matches that too. Without the
        # second test a "Hotel nightly cap" scoped to category 'travel' also
        # governs flights, which is how a legitimate flight claim was wrongly
        # excluded.
        item_name = str(item.get("name", "")).lower()
        item_category = str(item.get("category_hint") or "").lower()
        applicable = []
        for r in rules:
            category = (r.get("category") or "").lower()
            if category and category not in item_category:
                continue
            target = (r.get("text_value") or "").lower()
            if target and target not in item_name:
                continue
            applicable.append(r)
        claimed = Decimal(str(item.get("amount") or 0))
        for rule in applicable:
            if rule["rule_type"] == "max_amount" and rule.get("numeric_value"):
                limit = Decimal(rule["numeric_value"])
                # A per-night / per-day cap applies to each unit claimed.
                allowed = limit * max(int(item.get("quantity") or 1), 1)
                if claimed > allowed:
                    breaches.append(rule["message"])
            elif rule["rule_type"] == "receipt_required":
                threshold = (
                    Decimal(rule["numeric_value"])
                    if rule.get("numeric_value")
                    else Decimal("0")
                )
                # Only a line ABOVE the threshold needs one, and an unstated
                # receipt is unknown, not a breach -- the human decides.
                if claimed > threshold and item.get("receipt") is False:
                    breaches.append(rule["message"])

        results.append(
            {
                "name": item["name"],
                "quantity": item["quantity"],
                "amount": str(item.get("amount")) if item.get("amount") else None,
                "compliant": not breaches,
                "breaches": breaches,
                "assessed": bool(item.get("amount")),
                "rules_applied": [r["name"] for r in applicable],
            }
        )

    compliant = sum(1 for r in results if r["compliant"])
    if itemised:
        detail = f"{compliant} of {len(results)} claim line(s) comply with policy"
    else:
        detail = (
            f"{len(results)} claim line(s) recorded; no per-line amounts were "
            f"given, so limits could not be checked line by line"
        )
    await _finish_step(state, "policy_check", output={"summary": detail})
    return {
        "current_node": "policy_check",
        "policy_results": results,
        "trace": _trace("policy_check", detail),
    }


@node("compute_total")
async def compute_total(state: AgentState) -> dict[str, Any]:
    await _start_step(state, "compute_total")
    results = state.get("policy_results", [])
    itemised = any(r.get("amount") for r in results)

    if itemised:
        payable = sum(
            (
                Decimal(str(r["amount"]))
                for r in results
                if r["compliant"] and r.get("amount")
            ),
            Decimal("0"),
        )
    else:
        # No breakdown was supplied, so the claimed total stands as the
        # payable figure -- subject to the human check that follows.
        payable = Decimal(state["budget"]) if state.get("budget") else Decimal("0")

    excluded = [r["name"] for r in results if not r["compliant"]]
    detail = f"Payable {state.get('currency')} {payable:,.2f}" + (
        f"; excluded: {', '.join(excluded)}" if excluded else ""
    )
    if not itemised:
        detail += " (claimed total; no per-line breakdown supplied)"
    await _finish_step(state, "compute_total", output={"summary": detail})
    return {
        "current_node": "compute_total",
        "payable_total": str(payable),
        "justification": detail,
        "trace": _trace("compute_total", detail),
    }


@node("generate_summary")
async def generate_summary(state: AgentState) -> dict[str, Any]:
    """Render the reimbursement claim summary.

    Drives the SAME po_generator tool as procurement -- one renderer, two
    documents -- but builds its lines from the policy results rather than from
    a supplier quote, which a reimbursement does not have.
    """
    await _start_step(state, "generate_summary")
    workflow_id = UUID(state["workflow_id"])
    currency = state.get("currency", settings.default_currency)
    payable = (
        Decimal(state["payable_total"])
        if state.get("payable_total")
        else Decimal("0")
    )

    compliant = [r for r in state.get("policy_results", []) if r["compliant"]]
    lines = [
        POLine(
            description=r["name"],
            sku=None,
            quantity=int(r.get("quantity") or 1),
            unit_price=Decimal(str(r["amount"])) if r.get("amount") else Decimal("0"),
            line_total=Decimal(str(r["amount"])) if r.get("amount") else Decimal("0"),
        )
        for r in compliant
        if r.get("amount")
    ]
    if not lines:
        # Total-only claim: one line for the whole amount.
        lines = [
            POLine(
                description="Claimed expenses",
                sku=None,
                quantity=1,
                unit_price=payable,
                line_total=payable,
            )
        ]

    claim_no = f"CLAIM-{datetime.now(UTC).year}-{str(workflow_id)[:8]}"
    result = await _run_tool(
        state,
        "generate_summary",
        "po_generator",
        POGeneratorPayload(
            po_number=claim_no,
            vendor_name=state.get("approver") or "Expense claim",
            currency=currency,
            lines=lines,
            subtotal=payable,
            tax=Decimal("0"),
            total_amount=payable,
            notes="Reimbursement claim summary.",
        ),
    )

    await _finish_step(
        state,
        "generate_summary",
        output={"summary": f"{claim_no} · {currency} {payable:,.2f}"},
    )
    return {
        "current_node": "generate_summary",
        "po_number": claim_no,
        "pdf_path": result.value.object_path if result.ok and result.value else None,
        "trace": _trace("generate_summary", f"Rendered claim summary {claim_no}."),
    }


# ==========================================================================
# Branch predicates -- referenced by name from the YAML templates
# ==========================================================================
def has_qualifying_vendors(state: AgentState) -> str:
    """Zero qualifying suppliers must never fall through to PO generation."""
    return "true" if state.get("qualifying_vendor_ids") else "false"


def validation_outcome(state: AgentState) -> str:
    """passed -> approval; retry -> regenerate; escalate -> human.

    A retry is only ever offered when there is something to repair. If
    generate_po itself failed -- no PO row, or the node raised -- retrying
    would rebuild from the same broken inputs and loop until LangGraph's
    recursion limit. That case escalates immediately instead.
    """
    if state.get("validation_passed"):
        return "passed"

    if state.get("error") or not state.get("purchase_order_id"):
        return "escalate"

    attempts = int(state.get("generation_attempt", 1))
    allowed = int(
        state.get(
            "max_self_correction_attempts",
            settings.agent.max_self_correction_attempts,
        )
    )
    # attempt 1 is the original build; `allowed` further attempts may follow.
    return "retry" if attempts <= allowed else "escalate"


def has_compliant_lines(state: AgentState) -> str:
    return (
        "true"
        if any(r.get("compliant") for r in state.get("policy_results", []))
        else "false"
    )


_PREDICATES: dict[str, Callable[[AgentState], str]] = {
    "has_qualifying_vendors": has_qualifying_vendors,
    "validation_outcome": validation_outcome,
    "has_compliant_lines": has_compliant_lines,
}


def get_predicate(name: str) -> Callable[[AgentState], str]:
    try:
        return _PREDICATES[name]
    except KeyError:
        raise KeyError(
            f"unknown branch predicate {name!r}; registered: {sorted(_PREDICATES)}"
        ) from None


def available_predicates() -> list[str]:
    return sorted(_PREDICATES)
