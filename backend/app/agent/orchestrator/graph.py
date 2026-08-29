"""Compile a workflow template into a LangGraph StateGraph.

This module contains NO per-workflow-type logic. It reads nodes, edges and
branch predicates from the template and wires them up. Both procurement (8
nodes, a budget branch and a self-correction cycle) and reimbursement (6
nodes, a policy branch) compile through the identical code path -- which is
the point: adding a workflow type is adding a YAML file.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any
from uuid import UUID

import structlog
from langgraph.errors import GraphBubbleUp
from langgraph.graph import END as LG_END
from langgraph.graph import START, StateGraph
from langgraph.types import Command

from app.agent.orchestrator import nodes as node_module
from app.agent.orchestrator.state import AgentState, initial_state
from app.agent.orchestrator.template import (
    END,
    WorkflowTemplate,
    for_workflow_type,
    load_template,
)
from app.core.config import settings
from app.schemas.enums import WorkflowType

log = structlog.get_logger(__name__)


def _wrap(handler_name: str):
    """Bind a template node to its registered handler.

    A handler that raises would otherwise abort the whole graph. We catch,
    record the fault on the state, and let the template's own edges route to
    flag_for_human -- the workflow never crashes.
    """
    handler = node_module.get_handler(handler_name)

    async def _run(state: AgentState) -> dict[str, Any]:
        try:
            return await handler(state)
        except GraphBubbleUp:
            # interrupt() signals the human gate by raising. Swallowing it
            # here would convert the suspension into an error and let the run
            # continue past the approval gate -- exactly what must never
            # happen. Control-flow signals propagate; faults are caught below.
            raise
        except Exception as exc:  # noqa: BLE001 - deliberate: never crash a run
            log.exception(
                "node.failed",
                handler=handler_name,
                workflow_id=state.get("workflow_id"),
            )
            failure = {
                "current_node": handler_name,
                "error": f"{type(exc).__name__}: {exc}",
                "escalated": True,
                "escalation_reason": f"{handler_name} failed: {exc}",
            }
            # Advance the attempt counter even on the exception path, so a
            # node that throws inside the generate -> validate cycle still
            # exhausts its budget instead of looping.
            if handler_name == "generate_po":
                failure["generation_attempt"] = int(
                    state.get("generation_attempt", 0)
                ) + 1
            return failure

    _run.__name__ = f"node_{handler_name}"
    return _run


def build_graph(template: WorkflowTemplate) -> StateGraph:
    """Turn a validated template into an uncompiled StateGraph."""
    graph: StateGraph = StateGraph(AgentState)

    for spec in template.nodes:
        graph.add_node(spec.name, _wrap(spec.handler))

    graph.add_edge(START, template.entry)

    for edge in template.edges:
        if edge.is_conditional:
            predicate = node_module.get_predicate(edge.conditional)
            mapping = {
                key: (LG_END if target == END else target)
                for key, target in edge.branches.items()
            }
            graph.add_conditional_edges(edge.source, predicate, mapping)
        else:
            target = LG_END if edge.target == END else edge.target
            graph.add_edge(edge.source, target)

    return graph


# One checkpointer for the whole process. Building it per run opened a fresh
# Postgres connection each time, on top of the SQLAlchemy pool, which is what
# tipped the project past Supabase's 15-connection ceiling.
_CHECKPOINTER: Any = None
_CHECKPOINTER_MANAGER: Any = None


async def get_checkpointer():
    """PostgresSaver when the database is configured, in-memory otherwise.

    The checkpointer is what lets ``interrupt()`` at route_approval survive a
    process restart: the graph state is written to Postgres, and a decision
    posted hours later resumes from exactly where it paused. The in-memory
    fallback keeps the engine runnable (and testable) before DATABASE_URL
    exists, but a restart then loses paused runs.
    """
    if not settings.database_configured:
        from langgraph.checkpoint.memory import MemorySaver

        log.warning("checkpointer.in_memory", reason="DATABASE_URL not configured")
        return MemorySaver(), None

    global _CHECKPOINTER, _CHECKPOINTER_MANAGER
    if _CHECKPOINTER is not None:
        # Manager withheld deliberately: the caller must NOT close a shared
        # checkpointer, or the next run finds a dead connection.
        return _CHECKPOINTER, None

    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    url = settings.effective_checkpointer_url
    # LangGraph wants a plain libpq URI, not a SQLAlchemy driver URL.
    for prefix in ("postgresql+psycopg://", "postgresql+asyncpg://"):
        if url.startswith(prefix):
            url = url.replace(prefix, "postgresql://", 1)

    manager = AsyncPostgresSaver.from_conn_string(url)
    saver = await manager.__aenter__()
    await saver.setup()
    _CHECKPOINTER, _CHECKPOINTER_MANAGER = saver, manager
    return saver, None


async def close_checkpointer() -> None:
    """Release the shared checkpointer at shutdown."""
    global _CHECKPOINTER, _CHECKPOINTER_MANAGER
    if _CHECKPOINTER_MANAGER is not None:
        await _CHECKPOINTER_MANAGER.__aexit__(None, None, None)
    _CHECKPOINTER, _CHECKPOINTER_MANAGER = None, None


@lru_cache
def _cached_template(name: str) -> WorkflowTemplate:
    return load_template(name)


async def compile_graph(template: WorkflowTemplate, checkpointer=None):
    """Compile a runnable graph. Pass a checkpointer to enable interrupts."""
    graph = build_graph(template)
    return graph.compile(checkpointer=checkpointer)


def thread_config(workflow_id: UUID | str) -> dict[str, Any]:
    """One checkpoint thread per workflow, so resume is addressable by id."""
    return {"configurable": {"thread_id": f"workflow:{workflow_id}"}}


def build_initial_state(
    *,
    workflow_id: UUID,
    org_id: UUID | None,
    requester_id: UUID,
    workflow_type: WorkflowType,
    request_text: str,
    currency: str,
    budget: Any,
    items: list[dict[str, Any]],
    approver: str | None,
) -> AgentState:
    template = for_workflow_type(workflow_type)
    return initial_state(
        workflow_id=str(workflow_id),
        org_id=str(org_id) if org_id else None,
        requester_id=str(requester_id),
        workflow_type=workflow_type.value,
        template_name=template.name,
        request_text=request_text,
        currency=currency,
        budget=str(budget) if budget is not None else None,
        items=items,
        approver=approver,
        max_self_correction_attempts=template.max_self_correction_attempts(),
    )


def resume_command(decision: str, comment: str | None = None) -> Command:
    """The value handed back into ``interrupt()`` when a human decides."""
    return Command(resume={"decision": decision, "comment": comment})


def describe_graph(template: WorkflowTemplate) -> dict[str, Any]:
    """Introspection for GET /admin/workflow-types."""
    return {
        "name": template.name,
        "version": template.version,
        "title": template.title,
        "description": template.description,
        "scoring_strategy": template.scoring_strategy,
        "nodes": [
            {
                "name": n.name,
                "title": n.title,
                "handler": n.handler,
                "tool": n.tool,
                "interrupt": n.interrupt,
            }
            for n in template.nodes
        ],
        "edges": [
            {
                "from": e.source,
                "to": e.target,
                "conditional": e.conditional,
                "branches": e.branches,
            }
            for e in template.edges
        ],
        "tools": template.tool_names,
        "interrupt_nodes": template.interrupt_nodes,
        "max_self_correction_attempts": template.max_self_correction_attempts(),
    }


def to_mermaid(template: WorkflowTemplate) -> str:
    """Render the template as a mermaid flowchart for the README."""
    lines = ["flowchart TD", "    START([Request])"]
    for n in template.nodes:
        shape = f'{n.name}["{n.title}"]'
        if n.interrupt:
            shape = f'{n.name}{{{{"{n.title}<br/>HUMAN GATE"}}}}'
        elif n.name == "flag_for_human":
            shape = f'{n.name}[/"{n.title}"/]'
        lines.append(f"    {shape}")
    lines.append(f"    START --> {template.entry}")
    for e in template.edges:
        if e.is_conditional:
            for key, target in e.branches.items():
                arrow = "END" if target == END else target
                lines.append(f"    {e.source} -->|{key}| {arrow}")
        else:
            arrow = "END" if e.target == END else e.target
            lines.append(f"    {e.source} --> {arrow}")
    for n in template.nodes:
        if n.tool:
            lines.append(f"    {n.name} -.-> tool_{n.tool}[({n.tool})]")
    return "\n".join(lines)
