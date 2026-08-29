"""Workflow template loading and validation.

A template is data: nodes, edges, tool keys and conditional branch names. The
engine compiles whatever it is given, so adding a workflow type is adding a
YAML file. Validation happens at load time -- an unknown handler, tool or
branch target fails loudly on startup rather than halfway through a live run.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import structlog
import yaml

from app.core.config import settings
from app.schemas.enums import ScoringStrategyName, WorkflowType

log = structlog.get_logger(__name__)

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"
END = "END"


class TemplateError(ValueError):
    """A template is malformed or references something that does not exist."""


@dataclass(frozen=True, slots=True)
class NodeSpec:
    name: str
    title: str
    description: str
    handler: str
    tool: str | None = None
    interrupt: bool = False


@dataclass(frozen=True, slots=True)
class EdgeSpec:
    source: str
    target: str | None = None
    conditional: str | None = None
    branches: dict[str, str] = field(default_factory=dict)

    @property
    def is_conditional(self) -> bool:
        return self.conditional is not None


@dataclass(slots=True)
class WorkflowTemplate:
    name: str
    version: int
    title: str
    description: str
    scoring_strategy: str
    entry: str
    terminal: list[str]
    nodes: list[NodeSpec]
    edges: list[EdgeSpec]
    overrides: dict[str, Any] = field(default_factory=dict)

    @property
    def node_map(self) -> dict[str, NodeSpec]:
        return {n.name: n for n in self.nodes}

    @property
    def tool_names(self) -> list[str]:
        return sorted({n.tool for n in self.nodes if n.tool})

    @property
    def interrupt_nodes(self) -> list[str]:
        return [n.name for n in self.nodes if n.interrupt]

    def plan_steps(self) -> list[dict[str, Any]]:
        """The plan shown on screen 3a before anything executes.

        Excludes escape-hatch nodes such as flag_for_human: the user is shown
        the intended path, and the branch is surfaced only if it fires.
        """
        reachable = [n for n in self.nodes if n.name != "flag_for_human"]
        return [
            {
                "order": i,
                "name": n.name,
                "title": n.title,
                "description": n.description,
                "tool_name": n.tool,
            }
            for i, n in enumerate(reachable, start=1)
        ]

    def setting(self, key: str, default: Any) -> Any:
        """Per-template override, falling back to the global config."""
        value = self.overrides.get(key)
        return default if value is None else value

    def max_self_correction_attempts(self) -> int:
        return int(
            self.setting(
                "max_self_correction_attempts",
                settings.agent.max_self_correction_attempts,
            )
        )

    def tool_max_attempts(self) -> int:
        return int(
            self.setting("tool_max_attempts", settings.agent.tool_max_attempts)
        )

    def resolved_strategy(self, *, is_multi_item: bool) -> ScoringStrategyName | None:
        """Map the template's declaration onto a registered strategy."""
        if self.scoring_strategy == "auto":
            return (
                ScoringStrategyName.MULTI_ITEM
                if is_multi_item
                else ScoringStrategyName.SINGLE_ITEM
            )
        try:
            return ScoringStrategyName(self.scoring_strategy)
        except ValueError:
            raise TemplateError(
                f"template {self.name!r} declares unknown scoring_strategy "
                f"{self.scoring_strategy!r}"
            ) from None


def _parse(raw: dict[str, Any], source: str) -> WorkflowTemplate:
    required = ("name", "entry", "nodes", "edges")
    for key in required:
        if key not in raw:
            raise TemplateError(f"{source}: missing required key {key!r}")

    nodes = [
        NodeSpec(
            name=n["name"],
            title=n.get("title", n["name"].replace("_", " ").title()),
            description=n.get("description", ""),
            handler=n.get("handler", n["name"]),
            tool=n.get("tool"),
            interrupt=bool(n.get("interrupt", False)),
        )
        for n in raw["nodes"]
    ]

    edges: list[EdgeSpec] = []
    for e in raw["edges"]:
        if "from" not in e:
            raise TemplateError(f"{source}: edge missing 'from': {e}")
        edges.append(
            EdgeSpec(
                source=e["from"],
                target=e.get("to"),
                conditional=e.get("conditional"),
                branches={str(k): str(v) for k, v in (e.get("branches") or {}).items()},
            )
        )

    template = WorkflowTemplate(
        name=raw["name"],
        version=int(raw.get("version", 1)),
        title=raw.get("title", raw["name"].title()),
        description=raw.get("description", "").strip(),
        scoring_strategy=raw.get("scoring_strategy", "auto"),
        entry=raw["entry"],
        terminal=list(raw.get("terminal", [])),
        nodes=nodes,
        edges=edges,
        overrides=dict(raw.get("settings") or {}),
    )
    _validate(template, source)
    return template


def _validate(template: WorkflowTemplate, source: str) -> None:
    names = template.node_map
    if template.entry not in names:
        raise TemplateError(
            f"{source}: entry {template.entry!r} is not a declared node"
        )

    # Duplicate node names would silently shadow one another.
    seen: set[str] = set()
    for node in template.nodes:
        if node.name in seen:
            raise TemplateError(f"{source}: duplicate node {node.name!r}")
        seen.add(node.name)

    # Tools must exist in the registry, or the run dies mid-flight.
    from app.agent.tools import registry as tool_registry

    tool_registry._load_builtin_tools()
    for node in template.nodes:
        if node.tool and not tool_registry.has(node.tool):
            raise TemplateError(
                f"{source}: node {node.name!r} references unregistered tool "
                f"{node.tool!r}; registered: {tool_registry.available()}"
            )

    for edge in template.edges:
        if edge.source not in names:
            raise TemplateError(f"{source}: edge from unknown node {edge.source!r}")
        targets = list(edge.branches.values()) if edge.is_conditional else (
            [edge.target] if edge.target else []
        )
        if not targets:
            raise TemplateError(
                f"{source}: edge from {edge.source!r} has neither 'to' nor 'branches'"
            )
        for target in targets:
            if target != END and target not in names:
                raise TemplateError(
                    f"{source}: edge {edge.source!r} -> {target!r} targets an "
                    f"unknown node"
                )

    # Every non-terminal node must be able to make progress.
    with_outgoing = {e.source for e in template.edges}
    for node in template.nodes:
        if node.name not in with_outgoing:
            raise TemplateError(
                f"{source}: node {node.name!r} has no outgoing edge and would "
                f"strand the run"
            )


@lru_cache
def load_template(name: str) -> WorkflowTemplate:
    path = TEMPLATE_DIR / f"{name}.yaml"
    if not path.exists():
        available = sorted(p.stem for p in TEMPLATE_DIR.glob("*.yaml"))
        raise TemplateError(
            f"no workflow template named {name!r}; available: {available}"
        )
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    template = _parse(raw, path.name)
    log.info(
        "template.loaded",
        name=template.name,
        nodes=len(template.nodes),
        tools=template.tool_names,
    )
    return template


def for_workflow_type(workflow_type: WorkflowType) -> WorkflowTemplate:
    return load_template(workflow_type.value)


def available_templates() -> list[str]:
    return sorted(p.stem for p in TEMPLATE_DIR.glob("*.yaml"))


def load_all() -> dict[str, WorkflowTemplate]:
    """Validate every template. Called at startup so a broken file fails fast."""
    return {name: load_template(name) for name in available_templates()}
