"""Scoring strategy registry.

Adding a strategy is one new file plus one ``register()`` line. Nothing in the
orchestrator, the nodes or the API changes.

Selection is by capability (``supports()``), not by an if/else on item count,
so a future strategy can claim a request shape without editing this file's
logic.
"""
from __future__ import annotations

from app.agent.scoring.base import ScoringContext, ScoringStrategy
from app.agent.scoring.multi_item import MultiItemScoringStrategy
from app.agent.scoring.single_item import SingleItemScoringStrategy
from app.schemas.enums import ScoringStrategyName

_REGISTRY: dict[ScoringStrategyName, ScoringStrategy] = {}


def register(strategy: ScoringStrategy) -> ScoringStrategy:
    if strategy.name in _REGISTRY:
        raise ValueError(f"scoring strategy {strategy.name!r} is already registered")
    _REGISTRY[strategy.name] = strategy
    return strategy


def get(name: ScoringStrategyName) -> ScoringStrategy:
    try:
        return _REGISTRY[name]
    except KeyError:
        raise KeyError(
            f"unknown scoring strategy {name!r}; registered: {sorted(_REGISTRY)}"
        ) from None


def available() -> list[ScoringStrategyName]:
    return sorted(_REGISTRY)


def select(context: ScoringContext) -> ScoringStrategy:
    """Pick the first registered strategy that supports this request shape.

    Multi-item is checked before single-item because its ``supports()`` is the
    more specific predicate.
    """
    for name in (
        ScoringStrategyName.MULTI_ITEM,
        ScoringStrategyName.SINGLE_ITEM,
        ScoringStrategyName.POLICY_COMPLIANCE,
    ):
        strategy = _REGISTRY.get(name)
        if strategy is not None and strategy.supports(context):
            return strategy
    raise LookupError(
        "no registered scoring strategy supports this request shape "
        f"(items={len(context.item_names)}, offers={len(context.offers)})"
    )


# -- built-in strategies ------------------------------------------------
register(SingleItemScoringStrategy())
register(MultiItemScoringStrategy())

__all__ = ["register", "get", "select", "available", "ScoringStrategy", "ScoringContext"]
