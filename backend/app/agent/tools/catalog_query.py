"""catalog_query -- the agent's only route to supplier data.

CRITICAL ARCHITECTURAL RULE: this tool reads our own Supabase Postgres and
nothing else. It makes no outbound HTTP call, ever. Vendor catalogs arrive in
our database by a separate vendor-side path (manual entry, CSV import, or a
scheduled catalog sync) that is entirely outside the agent execution path.
That is what keeps a run fast, deterministic and replayable.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from uuid import UUID

import structlog

from app.agent.scoring.base import OfferLine, VendorOffer, VendorReliability
from app.agent.tools.base import Tool, ToolContext
from app.core.config import settings
from app.db.models import CatalogItem, Vendor
from app.repositories.catalog_repo import CatalogRepository, VendorRepository
from app.db.session import session_scope

log = structlog.get_logger(__name__)

# Words that carry no discriminating power when matching a catalog.
_STOPWORDS = frozenset(
    {"the", "a", "an", "of", "for", "and", "with", "units", "unit", "kits", "kit",
     "pieces", "piece", "pcs", "nos", "new", "each"}
)


@dataclass(slots=True)
class CatalogQueryPayload:
    """One requested line item, plus optional vendor narrowing."""

    items: list[dict[str, Any]]          # [{name, quantity, specification, category_hint}]
    org_id: UUID | None = None
    vendor_ids: list[UUID] | None = None


def build_search_terms(item: dict[str, Any]) -> list[str]:
    """Derive ILIKE terms from a requested item.

    Deliberately simple and deterministic: the same request must produce the
    same quotes on every run, or the audit trail means nothing.
    """
    parts: list[str] = []
    for field in ("name", "specification", "category_hint"):
        value = item.get(field)
        if value:
            parts.extend(str(value).replace("/", " ").replace("-", " ").split())

    terms: list[str] = []
    for word in parts:
        cleaned = word.strip().lower()
        if len(cleaned) < 3 or cleaned in _STOPWORDS:
            continue
        # Crude singularisation so "laptops" matches a "laptop" title.
        if cleaned.endswith("s") and len(cleaned) > 4:
            cleaned = cleaned[:-1]
        if cleaned not in terms:
            terms.append(cleaned)
    return terms or [str(item.get("name", "")).strip().lower()]


def _reliability(vendor: Vendor) -> VendorReliability:
    """Build the reliability block from real fulfilment history.

    A vendor below the configured minimum order count reports no history: it
    is scored neutrally, but the caller must surface the caveat.
    """
    has_history = (
        vendor.orders_fulfilled >= settings.vendor.min_orders_for_reliability
    )
    return VendorReliability(
        has_history=has_history,
        orders_fulfilled=vendor.orders_fulfilled,
        on_time_rate=float(vendor.on_time_rate) if vendor.on_time_rate is not None else None,
        quantity_accuracy=(
            float(vendor.quantity_accuracy)
            if vendor.quantity_accuracy is not None
            else None
        ),
        cancellations=vendor.cancellations,
        late_deliveries=vendor.late_deliveries,
    )


def _best_item_per_vendor(
    rows: list[tuple[Vendor, CatalogItem]]
) -> dict[UUID, tuple[Vendor, CatalogItem]]:
    """A vendor listing several matching SKUs contributes its cheapest."""
    best: dict[UUID, tuple[Vendor, CatalogItem]] = {}
    for vendor, item in rows:
        price = CatalogRepository.effective_price(item)
        current = best.get(vendor.id)
        if current is None or price < CatalogRepository.effective_price(current[1]):
            best[vendor.id] = (vendor, item)
    return best


class CatalogQueryTool(Tool[CatalogQueryPayload, list[VendorOffer]]):
    name = "catalog_query"
    description = (
        "Read vendor catalogs from the AgentFlow database and assemble one "
        "offer per vendor across every requested line item. Never makes an "
        "outbound network call."
    )

    async def run(
        self, payload: CatalogQueryPayload, ctx: ToolContext
    ) -> list[VendorOffer]:
        async with session_scope() as session:
            catalog = CatalogRepository(session)
            vendors = VendorRepository(session)

            # A vendor appears in the comparison if it can supply at least one
            # requested item; missing lines are recorded as unavailable so the
            # coverage matrix on screen 11a can show "Not stocked".
            per_item: dict[str, dict[UUID, tuple[Vendor, CatalogItem]]] = {}
            vendor_rows: dict[UUID, Vendor] = {}

            for item in payload.items:
                terms = build_search_terms(item)
                rows = await catalog.find_offers(
                    org_id=payload.org_id,
                    terms=terms,
                    quantity=int(item.get("quantity", 1)),
                    vendor_ids=payload.vendor_ids,
                )
                best = _best_item_per_vendor(list(rows))
                per_item[item["name"]] = best
                for vendor_id, (vendor, _) in best.items():
                    vendor_rows[vendor_id] = vendor

                log.info(
                    "catalog_query.item",
                    item=item["name"],
                    terms=terms,
                    vendors_matched=len(best),
                    workflow_id=str(ctx.workflow_id),
                )

            if not vendor_rows:
                # Not an error: zero matches is a legitimate outcome that the
                # graph handles by branching to flag_for_human.
                return []

            # Ensure suspended vendors never leak in through a stale row.
            allowed = {
                v.id for v in await vendors.selectable_for_quoting(payload.org_id)
            }

            offers: list[VendorOffer] = []
            for vendor_id, vendor in vendor_rows.items():
                if allowed and vendor_id not in allowed:
                    continue
                lines: list[OfferLine] = []
                for item in payload.items:
                    quantity = int(item.get("quantity", 1))
                    match = per_item.get(item["name"], {}).get(vendor_id)
                    if match is None:
                        lines.append(
                            OfferLine(
                                request_item_name=item["name"],
                                quantity=quantity,
                                available=False,
                            )
                        )
                        continue
                    _, catalog_item = match
                    lines.append(
                        OfferLine(
                            request_item_name=item["name"],
                            quantity=quantity,
                            available=True,
                            catalog_item_id=catalog_item.id,
                            sku=catalog_item.sku,
                            matched_title=catalog_item.title,
                            unit_price=CatalogRepository.effective_price(catalog_item),
                            delivery_days=catalog_item.delivery_days,
                            warranty_months=catalog_item.warranty_months,
                            stock_on_hand=catalog_item.stock,
                        )
                    )

                offers.append(
                    VendorOffer(
                        vendor_id=vendor.id,
                        vendor_name=vendor.name,
                        lines=lines,
                        reliability=_reliability(vendor),
                    )
                )

            offers.sort(
                key=lambda o: (
                    -o.items_covered,
                    o.total_amount if o.total_amount is not None else Decimal("9" * 18),
                )
            )
            log.info(
                "catalog_query.done",
                offers=len(offers),
                workflow_id=str(ctx.workflow_id),
            )
            return offers
