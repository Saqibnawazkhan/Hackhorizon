"""Tool registry.

    from app.agent.tools import registry
    registry.get("catalog_query")

Adding a tool:
    1. create app/agent/tools/my_tool.py with a Tool subclass
    2. add one register(MyTool()) line in ``_load_builtin_tools`` below

Nothing else changes -- not the orchestrator, not the nodes, not the API. A
workflow YAML references the tool by its string key, so a new template can use
a new tool with no Python edit at all.
"""
from __future__ import annotations

from app.agent.tools.base import Tool, ToolContext, ToolResult

_REGISTRY: dict[str, Tool] = {}


def register(tool: Tool, *, replace: bool = False) -> Tool:
    if tool.name in _REGISTRY and not replace:
        raise ValueError(f"tool {tool.name!r} is already registered")
    _REGISTRY[tool.name] = tool
    return tool


def get(name: str) -> Tool:
    try:
        return _REGISTRY[name]
    except KeyError:
        raise KeyError(
            f"unknown tool {name!r}; registered tools: {sorted(_REGISTRY)}"
        ) from None


def has(name: str) -> bool:
    return name in _REGISTRY


def available() -> list[str]:
    return sorted(_REGISTRY)


def describe() -> list[dict[str, str]]:
    """Exposed at GET /admin/tools so the registry is inspectable at runtime."""
    return [
        {"name": t.name, "description": t.description}
        for t in sorted(_REGISTRY.values(), key=lambda t: t.name)
    ]


def clear() -> None:
    """Test helper only."""
    _REGISTRY.clear()


def _load_builtin_tools() -> None:
    """Imported lazily so a missing optional dependency (reportlab, firebase)
    degrades that one tool instead of breaking application startup."""
    from app.agent.tools.catalog_query import CatalogQueryTool
    from app.agent.tools.notification import NotificationTool
    from app.agent.tools.po_generator import POGeneratorTool

    for tool in (CatalogQueryTool(), POGeneratorTool(), NotificationTool()):
        if tool.name not in _REGISTRY:
            register(tool)


__all__ = [
    "register",
    "get",
    "has",
    "available",
    "describe",
    "clear",
    "Tool",
    "ToolContext",
    "ToolResult",
]
