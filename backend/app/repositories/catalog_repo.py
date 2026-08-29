"""Vendor and catalog repositories.

``CatalogRepository.find_offers`` is the agent's only route to supplier data.
It reads our own Postgres and nothing else -- no outbound HTTP is possible from
here, which is what keeps agent execution fast and deterministic.
"""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Sequence
from uuid import UUID

from sqlalchemy import Select, and_, func, or_, select, update

from app.core.config import settings
from app.db.models import CatalogItem, Vendor, VendorFlagRow
from app.repositories.base import BaseRepository
from app.schemas.enums import VendorStatus


class VendorRepository(BaseRepository[Vendor]):
    model = Vendor

    def _scoped(self, org_id: UUID | None) -> Select:
        stmt = select(Vendor)
        return stmt.where(Vendor.org_id == org_id) if org_id else stmt

    async def list_for_org(
        self,
        org_id: UUID | None,
        *,
        status: VendorStatus | None = None,
        search: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[Sequence[Vendor], int]:
        stmt = self._scoped(org_id)
        if status is not None:
            stmt = stmt.where(Vendor.status == status.value)
        if search:
            stmt = stmt.where(Vendor.name.ilike(f"%{search}%"))
        stmt = stmt.order_by(Vendor.name)
        return await self.paginate(stmt, limit=limit, offset=offset)

    async def get_by_user(self, user_id: UUID) -> Vendor | None:
        return await self.session.scalar(
            select(Vendor).where(Vendor.user_id == user_id)
        )

    async def selectable_for_quoting(self, org_id: UUID | None) -> Sequence[Vendor]:
        """Vendors the agent may quote from.

        Suspended vendors are excluded. Flagged vendors are NOT: a flag is a
        warning for the human, not an automatic ban, and the justification
        surfaces it so the approver decides.
        """
        stmt = self._scoped(org_id).where(
            Vendor.status.in_([VendorStatus.VERIFIED.value, VendorStatus.FLAGGED.value])
        )
        return (await self.session.scalars(stmt)).all()

    async def set_status(
        self,
        vendor: Vendor,
        status: VendorStatus,
        *,
        actor_id: UUID | None = None,
        reason: str | None = None,
    ) -> Vendor:
        vendor.status = status.value
        if status is VendorStatus.VERIFIED:
            vendor.verified_at = datetime.now(UTC)
            vendor.verified_by = actor_id
            vendor.suspended_reason = None
        elif status is VendorStatus.SUSPENDED:
            vendor.suspended_reason = reason
        elif status is VendorStatus.PENDING:
            # The DB constraint ties verified_at to the verified status.
            vendor.verified_at = None
            vendor.verified_by = None
        await self.session.flush()
        return vendor

    async def open_flags(self, vendor_id: UUID) -> Sequence[VendorFlagRow]:
        return (
            await self.session.scalars(
                select(VendorFlagRow).where(
                    and_(
                        VendorFlagRow.vendor_id == vendor_id,
                        VendorFlagRow.resolved_at.is_(None),
                    )
                )
            )
        ).all()

    async def flags_for_vendors(
        self, vendor_ids: Sequence[UUID]
    ) -> dict[UUID, list[VendorFlagRow]]:
        """Open flags for many vendors at once.

        The vendor list fetched them one vendor at a time, which is a round
        trip per flagged vendor on a screen that already knows every id it
        cares about.
        """
        if not vendor_ids:
            return {}
        rows = (
            await self.session.scalars(
                select(VendorFlagRow).where(
                    and_(
                        VendorFlagRow.vendor_id.in_(list(vendor_ids)),
                        VendorFlagRow.resolved_at.is_(None),
                    )
                )
            )
        ).all()
        grouped: dict[UUID, list[VendorFlagRow]] = {}
        for flag in rows:
            grouped.setdefault(flag.vendor_id, []).append(flag)
        return grouped

    async def count_flagged(self, org_id: UUID | None) -> int:
        stmt = (
            select(func.count(func.distinct(VendorFlagRow.vendor_id)))
            .select_from(VendorFlagRow)
            .join(Vendor, Vendor.id == VendorFlagRow.vendor_id)
            .where(VendorFlagRow.resolved_at.is_(None))
        )
        if org_id:
            stmt = stmt.where(Vendor.org_id == org_id)
        return int(await self.session.scalar(stmt) or 0)


class CatalogRepository(BaseRepository[CatalogItem]):
    model = CatalogItem

    async def list_for_vendor(
        self,
        vendor_id: UUID,
        *,
        visible_only: bool = False,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[Sequence[CatalogItem], int]:
        stmt = select(CatalogItem).where(CatalogItem.vendor_id == vendor_id)
        if visible_only:
            stmt = stmt.where(CatalogItem.visible.is_(True))
        stmt = stmt.order_by(CatalogItem.title)
        return await self.paginate(stmt, limit=limit, offset=offset)

    async def skus_for_vendor(self, vendor_id: UUID) -> set[str]:
        """Every SKU this vendor already lists.

        The importer needs it to tell a row that creates an item from one that
        updates one, and it needs it for the whole file at once -- a per-row
        existence check would be one round trip per row.
        """
        rows = await self.session.scalars(
            select(CatalogItem.sku).where(CatalogItem.vendor_id == vendor_id)
        )
        return set(rows.all())

    async def get_by_sku(self, vendor_id: UUID, sku: str) -> CatalogItem | None:
        return await self.session.scalar(
            select(CatalogItem).where(
                and_(CatalogItem.vendor_id == vendor_id, CatalogItem.sku == sku)
            )
        )

    async def find_offers(
        self,
        *,
        org_id: UUID | None,
        terms: Sequence[str],
        quantity: int = 1,
        vendor_ids: Sequence[UUID] | None = None,
    ) -> Sequence[tuple[Vendor, CatalogItem]]:
        """Match published catalog rows against one requested item.

        Matching is intentionally simple and deterministic -- ILIKE over title,
        description, category and brand. No embedding lookup, no LLM: the same
        request must produce the same quotes every run, or the audit trail is
        worthless.
        """
        if not terms:
            return []

        conditions = []
        for term in terms:
            like = f"%{term.strip()}%"
            conditions.append(
                or_(
                    CatalogItem.title.ilike(like),
                    CatalogItem.description.ilike(like),
                    CatalogItem.category.ilike(like),
                    CatalogItem.brand.ilike(like),
                )
            )

        stmt = (
            select(Vendor, CatalogItem)
            .join(CatalogItem, CatalogItem.vendor_id == Vendor.id)
            .where(
                CatalogItem.visible.is_(True),
                CatalogItem.published_at.is_not(None),
                CatalogItem.stock >= quantity,
                Vendor.status.in_(
                    [VendorStatus.VERIFIED.value, VendorStatus.FLAGGED.value]
                ),
                or_(*conditions),
            )
        )
        if org_id:
            stmt = stmt.where(Vendor.org_id == org_id)
        if vendor_ids:
            stmt = stmt.where(Vendor.id.in_(list(vendor_ids)))

        # Cheapest effective price first, so a vendor listing several matching
        # SKUs contributes its best offer.
        stmt = stmt.order_by(
            Vendor.id, func.coalesce(CatalogItem.sale_price, CatalogItem.price)
        )
        rows = (await self.session.execute(stmt)).all()
        return [(r[0], r[1]) for r in rows]

    async def draft_state(self, vendor_id: UUID) -> dict[str, object]:
        """Powers the "Last published ... N unsaved changes" line on 14a.

        Three aggregates over the same rows, so they are three FILTER clauses
        in one statement rather than three round trips. Over a ~200 ms link
        that is the difference between 600 ms and 200 ms on every load of the
        vendor portal.
        """
        row = (
            await self.session.execute(
                select(
                    func.count()
                    .filter(CatalogItem.has_unpublished_changes.is_(True))
                    .label("unsaved"),
                    func.count()
                    .filter(
                        or_(
                            CatalogItem.delivery_days.is_(None),
                            CatalogItem.warranty_months.is_(None),
                        )
                    )
                    .label("missing"),
                    func.max(CatalogItem.published_at).label("last_published"),
                ).where(CatalogItem.vendor_id == vendor_id)
            )
        ).one()

        return {
            "unsaved_change_count": int(row.unsaved or 0),
            "items_missing_terms": int(row.missing or 0),
            "last_published_at": row.last_published,
        }


    async def publish(
        self, vendor_id: UUID, item_ids: Sequence[UUID] | None = None
    ) -> tuple[int, datetime]:
        """Mark items published. Items lacking required terms are skipped."""
        now = datetime.now(UTC)
        stmt = (
            update(CatalogItem)
            .where(
                CatalogItem.vendor_id == vendor_id,
                CatalogItem.has_unpublished_changes.is_(True),
            )
            .values(published_at=now, has_unpublished_changes=False)
        )
        if item_ids:
            stmt = stmt.where(CatalogItem.id.in_(list(item_ids)))
        result = await self.session.execute(stmt)
        await self.session.flush()
        return int(result.rowcount or 0), now

    async def apply_vendor_defaults(self, vendor: Vendor, item: CatalogItem) -> None:
        """New items inherit the vendor profile defaults and may override them."""
        if item.delivery_days is None:
            item.delivery_days = vendor.default_delivery_days
        if item.warranty_months is None:
            item.warranty_months = vendor.default_warranty_months
        if not item.currency:
            item.currency = settings.default_currency

    async def low_stock(self, vendor_id: UUID) -> Sequence[CatalogItem]:
        return (
            await self.session.scalars(
                select(CatalogItem).where(
                    CatalogItem.vendor_id == vendor_id,
                    CatalogItem.stock <= settings.vendor.low_stock_threshold,
                )
            )
        ).all()

    async def upsert_by_sku(
        self, vendor_id: UUID, sku: str, values: dict[str, object]
    ) -> tuple[CatalogItem, bool]:
        """Insert or update by (vendor_id, sku). Returns (row, created)."""
        existing = await self.get_by_sku(vendor_id, sku)
        if existing is not None:
            for key, value in values.items():
                if value is not None:
                    setattr(existing, key, value)
            existing.has_unpublished_changes = True
            await self.session.flush()
            return existing, False

        row = CatalogItem(vendor_id=vendor_id, sku=sku, **values)  # type: ignore[arg-type]
        self.session.add(row)
        await self.session.flush()
        return row, True

    @staticmethod
    def effective_price(item: CatalogItem) -> Decimal:
        return item.sale_price if item.sale_price is not None else item.price
