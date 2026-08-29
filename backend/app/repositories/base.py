"""Repository base.

All database access goes through a repository. Business logic -- the
orchestrator nodes, the scoring engine, the API routers -- never writes SQL and
never touches a Session directly. Swapping Supabase for another Postgres, or
adding read replicas, is then a change confined to this layer.
"""
from __future__ import annotations

from typing import Any, Generic, Sequence, TypeVar
from uuid import UUID

from sqlalchemy import Select, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models import Base

TModel = TypeVar("TModel", bound=Base)


class NotFoundError(LookupError):
    """A row the caller required does not exist."""

    def __init__(self, entity: str, identifier: object) -> None:
        super().__init__(f"{entity} {identifier!r} not found")
        self.entity = entity
        self.identifier = identifier


class BaseRepository(Generic[TModel]):
    model: type[TModel]

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # -- reads ---------------------------------------------------------
    async def get(self, entity_id: UUID) -> TModel | None:
        return await self.session.get(self.model, entity_id)

    async def get_or_raise(self, entity_id: UUID) -> TModel:
        row = await self.get(entity_id)
        if row is None:
            raise NotFoundError(self.model.__name__, entity_id)
        return row

    async def list_all(
        self, *, limit: int | None = None, offset: int = 0
    ) -> Sequence[TModel]:
        stmt = select(self.model).offset(offset).limit(
            limit or settings.default_page_size
        )
        return (await self.session.scalars(stmt)).all()

    async def count(self, stmt: Select[Any] | None = None) -> int:
        base = stmt if stmt is not None else select(self.model)
        subq = base.order_by(None).subquery()
        return int(
            await self.session.scalar(select(func.count()).select_from(subq)) or 0
        )

    async def paginate(
        self, stmt: Select[Any], *, limit: int, offset: int
    ) -> tuple[Sequence[TModel], int]:
        """Return one page plus the unpaginated total, in that order."""
        total = await self.count(stmt)
        capped = min(limit, settings.max_page_size)
        rows = (await self.session.scalars(stmt.offset(offset).limit(capped))).all()
        return rows, total

    # -- writes --------------------------------------------------------
    def add(self, row: TModel) -> TModel:
        self.session.add(row)
        return row

    def add_all(self, rows: Sequence[TModel]) -> Sequence[TModel]:
        self.session.add_all(list(rows))
        return rows

    async def create(self, **values: Any) -> TModel:
        row = self.model(**values)
        self.session.add(row)
        await self.session.flush()
        return row

    async def update(self, row: TModel, **values: Any) -> TModel:
        for key, value in values.items():
            if value is not None or key in getattr(row, "_nullable_updates", ()):
                setattr(row, key, value)
        await self.session.flush()
        return row

    async def delete(self, entity_id: UUID) -> int:
        result = await self.session.execute(
            delete(self.model).where(self.model.id == entity_id)  # type: ignore[attr-defined]
        )
        return int(result.rowcount or 0)

    async def flush(self) -> None:
        await self.session.flush()
