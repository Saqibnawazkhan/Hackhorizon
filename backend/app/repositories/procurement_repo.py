"""Quote, purchase-order, approval and configuration repositories."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Sequence
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.orm import aliased, noload
from sqlalchemy.orm.attributes import set_committed_value

from app.core.config import settings
from app.db.models import (
    Approval,
    POFulfilmentEvent,
    POLineItem,
    PolicyRule,
    PurchaseOrder,
    Quote,
    QuoteLine,
    ScoringWeightRow,
    User,
    ValidationReportRow,
    Vendor,
    Workflow,
)
from app.repositories.base import BaseRepository
from app.schemas.admin import ScoringWeights
from app.schemas.enums import (
    ApprovalDecision,
    PODeliveryStatus,
    QuoteStatus,
    WorkflowStatus,
    WorkflowType,
)


class QuoteRepository(BaseRepository[Quote]):
    """Quotes carry frozen snapshots -- see PRICE SNAPSHOT INTEGRITY."""

    model = Quote

    async def for_workflow(self, workflow_id: UUID) -> Sequence[Quote]:
        return (
            await self.session.scalars(
                select(Quote)
                .where(Quote.workflow_id == workflow_id)
                .order_by(Quote.score_total.desc().nullslast())
            )
        ).all()

    async def snapshot(
        self,
        *,
        workflow_id: UUID,
        vendor_id: UUID,
        vendor_name: str,
        currency: str,
        items_requested: int,
        lines: Sequence[dict[str, Any]],
        reliability_score: Decimal | None,
        reliability_has_history: bool,
    ) -> Quote:
        """Freeze a vendor's terms at quote time.

        Every commercial value is copied onto the quote and its lines. Nothing
        downstream re-reads catalog_items, so a vendor republishing mid-run
        cannot alter an in-flight purchase order.
        """
        covered = [ln for ln in lines if ln.get("available") and ln.get("unit_price")]
        total = sum(
            (Decimal(str(ln["line_total"])) for ln in covered), Decimal("0")
        ) if covered else None

        delivery = [
            ln["delivery_days"] for ln in covered if ln.get("delivery_days") is not None
        ]
        warranty = [
            ln["warranty_months"]
            for ln in covered
            if ln.get("warranty_months") is not None
        ]

        # A RE-RUN RE-QUOTES THE SAME VENDOR.
        #
        # `POST /workflows/{id}/run` accepts a workflow in ESCALATED, which is
        # the whole point of escalation: a human fixes what was missing -- adds
        # a vendor, raises the budget, or gets a price through a quote request
        # -- and runs it again. But quotes carry
        # `unique (workflow_id, vendor_id)`, so the second run's INSERT hit a
        # UniqueViolation on the first vendor it had already seen and the run
        # died before scoring anything. Re-running was advertised and could
        # not work.
        #
        # Updating in place rather than deleting and re-inserting is
        # deliberate: purchase_orders.quote_id references this row, so a
        # workflow that escalated AFTER generating a PO would lose its
        # counterparty on a delete. The row keeps its identity and gets a
        # fresh snapshot, which is exactly what a re-quote is.
        quote = await self.session.scalar(
            select(Quote).where(
                Quote.workflow_id == workflow_id, Quote.vendor_id == vendor_id
            )
        )
        if quote is None:
            quote = Quote(workflow_id=workflow_id, vendor_id=vendor_id)
            self.session.add(quote)
        else:
            # The previous run's lines are stale the moment we re-quote.
            await self.session.execute(
                delete(QuoteLine).where(QuoteLine.quote_id == quote.id)
            )

        quote.vendor_name = vendor_name
        quote.currency = currency
        quote.status = QuoteStatus.QUOTED.value
        quote.total_amount = total
        quote.delivery_days = max(delivery) if delivery else None
        quote.warranty_months = min(warranty) if warranty else None
        quote.items_covered = len(covered)
        quote.items_requested = items_requested
        quote.reliability_score = reliability_score
        quote.reliability_has_history = reliability_has_history
        quote.snapshot_taken_at = datetime.now(UTC)
        # Scores belong to the run that computed them; a re-quote invalidates
        # them until score_rank writes new ones.
        quote.score_total = None
        quote.score_json = None
        quote.confidence_percent = None
        quote.exclusion_reason = None
        await self.session.flush()

        self.session.add_all(
            [
                QuoteLine(
                    quote_id=quote.id,
                    catalog_item_id=ln.get("catalog_item_id"),
                    workflow_item_id=ln.get("workflow_item_id"),
                    request_item_name=ln["request_item_name"],
                    matched_title=ln.get("matched_title"),
                    sku=ln.get("sku"),
                    quantity=ln["quantity"],
                    available=bool(ln.get("available")),
                    stock_on_hand=ln.get("stock_on_hand"),
                    unit_price=ln.get("unit_price"),
                    line_total=ln.get("line_total"),
                    delivery_days=ln.get("delivery_days"),
                    warranty_months=ln.get("warranty_months"),
                )
                for ln in lines
            ]
        )
        await self.session.flush()
        return quote

    async def apply_scores(
        self, workflow_id: UUID, scored: Sequence[dict[str, Any]]
    ) -> None:
        """Persist the scoring result so the comparison screen is reproducible."""
        by_vendor = {q.vendor_id: q for q in await self.for_workflow(workflow_id)}
        for entry in scored:
            quote = by_vendor.get(entry["vendor_id"])
            if quote is None:
                continue
            quote.status = entry["status"]
            quote.exclusion_reason = entry.get("exclusion_reason")
            quote.score_total = entry.get("score_total")
            quote.score_json = entry.get("score_json")
            quote.confidence_percent = entry.get("confidence_percent")
            quote.missing_fields = entry.get("missing_fields") or []
        await self.session.flush()

    async def selected(self, workflow_id: UUID) -> Quote | None:
        return await self.session.scalar(
            select(Quote).where(
                Quote.workflow_id == workflow_id,
                Quote.status == QuoteStatus.SELECTED.value,
            )
        )


class PurchaseOrderRepository(BaseRepository[PurchaseOrder]):
    model = PurchaseOrder

    async def next_po_number(self) -> str:
        year = datetime.now(UTC).year
        count = await self.session.scalar(
            select(func.count()).select_from(PurchaseOrder)
        )
        return f"PO-{year}-{int(count or 0) + 1:04d}"

    async def create_from_quote(
        self,
        *,
        workflow: Workflow,
        quote: Quote,
        attempt: int = 1,
        tax: Decimal = Decimal("0"),
        payment_terms: str | None = None,
        delivery_address: str | None = None,
    ) -> PurchaseOrder:
        """Build a PO from the SNAPSHOT, never from the live catalog."""
        covered = [ln for ln in quote.lines if ln.available and ln.unit_price]
        subtotal = sum(
            (ln.line_total or Decimal("0") for ln in covered), Decimal("0")
        )
        expected = (
            (datetime.now(UTC).date() + timedelta(days=quote.delivery_days))
            if quote.delivery_days is not None
            else None
        )

        po = PurchaseOrder(
            po_number=await self.next_po_number(),
            workflow_id=workflow.id,
            vendor_id=quote.vendor_id,
            quote_id=quote.id,
            subtotal=subtotal,
            tax=tax,
            total_amount=subtotal + tax,
            currency=quote.currency,
            delivery_days=quote.delivery_days,
            expected_delivery_date=expected,
            warranty_months=quote.warranty_months,
            payment_terms=payment_terms,
            delivery_address=delivery_address,
            delivery_status=PODeliveryStatus.ISSUED.value,
            generation_attempt=attempt,
        )
        self.session.add(po)
        await self.session.flush()

        lines = [
            POLineItem(
                purchase_order_id=po.id,
                quote_line_id=ln.id,
                catalog_item_id=ln.catalog_item_id,
                line_number=i,
                description=ln.matched_title or ln.request_item_name,
                sku=ln.sku,
                quantity=ln.quantity,
                unit_price=ln.unit_price or Decimal("0"),
                line_total=ln.line_total or Decimal("0"),
                delivery_days=ln.delivery_days,
                warranty_months=ln.warranty_months,
            )
            for i, ln in enumerate(covered, start=1)
        ]
        self.session.add_all(lines)
        await self.session.flush()

        # Populate the relationship in memory. selectin loading only applies to
        # rows fetched by a query; a freshly INSERTed parent would otherwise
        # lazy-load on first access, which raises MissingGreenlet under async.
        #
        # set_committed_value, not plain assignment: assigning to a collection
        # makes SQLAlchemy load the existing one first to compute the delta,
        # which is the very lazy load being avoided.
        set_committed_value(po, "line_items", lines)
        return po

    async def for_workflow(self, workflow_id: UUID) -> PurchaseOrder | None:
        return await self.session.scalar(
            select(PurchaseOrder)
            .where(PurchaseOrder.workflow_id == workflow_id)
            .order_by(PurchaseOrder.generation_attempt.desc())
        )

    async def for_vendor(
        self,
        vendor_id: UUID,
        *,
        status: PODeliveryStatus | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[Sequence[PurchaseOrder], int]:
        stmt = (
            select(PurchaseOrder)
            .join(Workflow, Workflow.id == PurchaseOrder.workflow_id)
            .where(
                PurchaseOrder.vendor_id == vendor_id,
                # Approved or later only. A PO exists from the moment the
                # agent generates it, which is before validation and before
                # anyone approves it -- and it survives a rejection. Showing
                # either to the supplier would be telling them about an order
                # that nobody has committed to, or one that was refused.
                Workflow.status.in_(
                    [
                        WorkflowStatus.APPROVED.value,
                        WorkflowStatus.COMPLETED.value,
                    ]
                ),
            )
        )
        if status is not None:
            stmt = stmt.where(PurchaseOrder.delivery_status == status.value)
        stmt = stmt.order_by(PurchaseOrder.created_at.desc())
        return await self.paginate(stmt, limit=limit, offset=offset)

    async def update_delivery(
        self,
        po: PurchaseOrder,
        *,
        status: PODeliveryStatus,
        quantity_delivered: int | None = None,
        delivered_at: datetime | None = None,
        note: str | None = None,
    ) -> PurchaseOrder:
        """Vendor-side update. Also writes the fulfilment fact that feeds
        reliability scoring -- the score is never entered directly."""
        po.delivery_status = status.value
        if quantity_delivered is not None:
            po.quantity_delivered = quantity_delivered
        if status is PODeliveryStatus.DELIVERED:
            po.delivered_at = delivered_at or datetime.now(UTC)
        elif status is not PODeliveryStatus.DELIVERED:
            po.delivered_at = None

        actual = (po.delivered_at.date() if po.delivered_at else None)
        days_late = None
        if actual and po.expected_delivery_date:
            days_late = max(0, (actual - po.expected_delivery_date).days)

        expected_qty = sum(li.quantity for li in po.line_items)
        self.session.add(
            POFulfilmentEvent(
                purchase_order_id=po.id,
                vendor_id=po.vendor_id,
                event=(
                    "delivered"
                    if status is PODeliveryStatus.DELIVERED
                    else "cancelled"
                    if status is PODeliveryStatus.CANCELLED
                    else "shipped"
                    if status is PODeliveryStatus.IN_TRANSIT
                    else "acknowledged"
                ),
                expected_date=po.expected_delivery_date,
                actual_date=actual,
                days_late=days_late,
                quantity_expected=expected_qty,
                quantity_actual=quantity_delivered,
                note=note,
            )
        )
        await self.session.flush()
        return po

    async def spend_by_vendor(
        self, org_id: UUID | None, since: datetime | None = None
    ) -> Sequence[tuple[UUID, str, int, Decimal]]:
        stmt = (
            select(
                PurchaseOrder.vendor_id,
                func.min(PurchaseOrder.po_number),
                func.count(),
                func.sum(PurchaseOrder.total_amount),
            )
            .join(Workflow, Workflow.id == PurchaseOrder.workflow_id)
            .group_by(PurchaseOrder.vendor_id)
        )
        if org_id:
            stmt = stmt.where(Workflow.org_id == org_id)
        if since:
            stmt = stmt.where(PurchaseOrder.created_at >= since)
        return [tuple(r) for r in (await self.session.execute(stmt)).all()]


class ValidationRepository(BaseRepository[ValidationReportRow]):
    model = ValidationReportRow

    async def record(
        self,
        *,
        workflow_id: UUID,
        purchase_order_id: UUID | None,
        attempt: int,
        max_attempts: int,
        passed: bool,
        checks: list[dict[str, Any]],
    ) -> ValidationReportRow:
        row = ValidationReportRow(
            workflow_id=workflow_id,
            purchase_order_id=purchase_order_id,
            attempt=attempt,
            max_attempts=max_attempts,
            passed=passed,
            checks_json=checks,
        )
        self.session.add(row)
        await self.session.flush()
        return row

    async def latest(self, workflow_id: UUID) -> ValidationReportRow | None:
        return await self.session.scalar(
            select(ValidationReportRow)
            .where(ValidationReportRow.workflow_id == workflow_id)
            .order_by(ValidationReportRow.attempt.desc())
        )


class ApprovalRepository(BaseRepository[Approval]):
    """THE AGENT NEVER AUTO-APPROVES.

    ``decide`` is the only method that moves an approval out of PENDING, and it
    requires a ``decided_by`` user id. No agent code path can call it without
    one, and the DB CHECK rejects a decided row that has no decider.
    """

    model = Approval

    async def open_for_workflow(self, workflow_id: UUID) -> Approval | None:
        return await self.session.scalar(
            select(Approval).where(
                Approval.workflow_id == workflow_id,
                Approval.decision == ApprovalDecision.PENDING.value,
            )
        )

    async def request(
        self,
        *,
        workflow_id: UUID,
        purchase_order_id: UUID | None,
        org_id: UUID | None,
    ) -> tuple[Approval, bool]:
        """The gate's approval row. Returns (approval, created).

        Matches on ANY approval for the workflow, not just an open one.

        ``interrupt()`` suspends inside this node, and LangGraph re-executes a
        node from the top when the run resumes -- so everything above the
        interrupt runs a second time, after the decision. Matching only open
        approvals meant the just-approved row no longer matched, a second
        PENDING approval was created, and the workflow bounced straight back
        to awaiting_approval with a fresh notification. Approving appeared not
        to take.

        ``created`` is what the caller uses to avoid re-announcing a gate that
        has already been announced and already answered.
        """
        existing = await self.session.scalar(
            select(Approval)
            .where(Approval.workflow_id == workflow_id)
            .order_by(Approval.requested_at.desc())
            .limit(1)
        )
        if existing is not None:
            return existing, False

        row = Approval(
            workflow_id=workflow_id,
            purchase_order_id=purchase_order_id,
            org_id=org_id,
            decision=ApprovalDecision.PENDING.value,
        )
        self.session.add(row)
        await self.session.flush()
        return row, True

    async def decide(
        self,
        approval: Approval,
        *,
        decision: ApprovalDecision,
        decided_by: UUID,
        comment: str | None = None,
        idempotency_key: str | None = None,
    ) -> tuple[Approval, bool]:
        """Returns (approval, changed). ``changed`` is False on a replay."""
        if decision is ApprovalDecision.PENDING:
            raise ValueError("cannot decide an approval as 'pending'")

        if approval.decision != ApprovalDecision.PENDING.value:
            # Idempotent replay -- a double-tap on Approve must not resume the
            # graph twice.
            return approval, False

        approval.decision = decision.value
        approval.decided_by = decided_by
        approval.decided_at = datetime.now(UTC)
        approval.comment = comment
        approval.idempotency_key = idempotency_key
        await self.session.flush()
        return approval, True

    async def queue(
        self, org_id: UUID | None, *, limit: int = 20, offset: int = 0
    ) -> tuple[Sequence[Approval], int]:
        stmt = select(Approval).where(
            Approval.decision == ApprovalDecision.PENDING.value
        )
        if org_id:
            stmt = stmt.where(Approval.org_id == org_id)
        stmt = stmt.order_by(Approval.requested_at.desc())
        return await self.paginate(stmt, limit=limit, offset=offset)

    async def queue_rows(
        self,
        org_id: UUID | None,
        *,
        requester_id: UUID | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """The approval queue in ONE round trip.

        ``queue`` returns Approval entities, which forced the router to fetch
        the workflow, the purchase order and the vendor per row -- and the PO
        dragged its line items along through a selectin load the queue never
        rendered. Joining here trades an ORM convenience for the difference
        between one round trip and fifty-eight.

        ``requester_id`` scopes the queue to one person's own requests, which
        is what an employee is allowed to see.
        """
        base = (
            select(Approval, Workflow, PurchaseOrder, Vendor)
            .join(Workflow, Workflow.id == Approval.workflow_id)
            .outerjoin(
                PurchaseOrder, PurchaseOrder.id == Approval.purchase_order_id
            )
            .outerjoin(Vendor, Vendor.id == PurchaseOrder.vendor_id)
            .where(Approval.decision == ApprovalDecision.PENDING.value)
            # The queue shows totals, never lines. Without this the selectin
            # load on PurchaseOrder.line_items fires for the whole page.
            .options(noload(PurchaseOrder.line_items))
        )
        if org_id:
            base = base.where(Approval.org_id == org_id)
        if requester_id is not None:
            base = base.where(Workflow.requester_id == requester_id)

        total = int(
            await self.session.scalar(
                select(func.count()).select_from(base.subquery())
            )
            or 0
        )

        rows = (
            await self.session.execute(
                base.order_by(Approval.requested_at.desc())
                .limit(limit)
                .offset(offset)
            )
        ).all()

        return [
            {"approval": a, "workflow": w, "purchase_order": p, "vendor": v}
            for a, w, p, v in rows
        ], total

    async def detail_row(self, approval_id: UUID) -> dict[str, Any] | None:
        """One approval with everything screen 12a renders, in one round trip.

        Approval, workflow, purchase order, vendor and the requester's name
        are five tables and were five sequential lookups. They are one join;
        only the line items load separately, because they are a collection.
        """
        requester = aliased(User)
        row = (
            await self.session.execute(
                select(Approval, Workflow, PurchaseOrder, Vendor, requester)
                .join(Workflow, Workflow.id == Approval.workflow_id)
                .outerjoin(
                    PurchaseOrder, PurchaseOrder.id == Approval.purchase_order_id
                )
                .outerjoin(Vendor, Vendor.id == PurchaseOrder.vendor_id)
                .outerjoin(requester, requester.id == Workflow.requester_id)
                .where(Approval.id == approval_id)
            )
        ).first()
        if row is None:
            return None
        a, w, p, v, r = row
        return {
            "approval": a,
            "workflow": w,
            "purchase_order": p,
            "vendor": v,
            "requester": r,
        }

    async def count_pending(self, org_id: UUID | None) -> int:
        stmt = (
            select(func.count())
            .select_from(Approval)
            .where(Approval.decision == ApprovalDecision.PENDING.value)
        )
        if org_id:
            stmt = stmt.where(Approval.org_id == org_id)
        return int(await self.session.scalar(stmt) or 0)


class ConfigRepository(BaseRepository[ScoringWeightRow]):
    """Admin-configurable scoring weights and policy rules."""

    model = ScoringWeightRow

    async def weights_for(self, org_id: UUID | None) -> tuple[ScoringWeights, bool]:
        """Returns (weights, is_default). Falls back to the env configuration."""
        row = (
            await self.session.get(ScoringWeightRow, org_id) if org_id else None
        )
        if row is None:
            s = settings.scoring
            return (
                ScoringWeights(
                    price=s.weight_price,
                    delivery=s.weight_delivery,
                    warranty=s.weight_warranty,
                    reliability=s.weight_reliability,
                ),
                True,
            )
        return (
            ScoringWeights(
                price=float(row.weight_price),
                delivery=float(row.weight_delivery),
                warranty=float(row.weight_warranty),
                reliability=float(row.weight_reliability),
            ),
            False,
        )

    async def set_weights(
        self, org_id: UUID, weights: ScoringWeights, *, updated_by: UUID | None
    ) -> ScoringWeightRow:
        row = await self.session.get(ScoringWeightRow, org_id)
        if row is None:
            row = ScoringWeightRow(org_id=org_id)
            self.session.add(row)
        row.weight_price = Decimal(str(weights.price))
        row.weight_delivery = Decimal(str(weights.delivery))
        row.weight_warranty = Decimal(str(weights.warranty))
        row.weight_reliability = Decimal(str(weights.reliability))
        row.updated_at = datetime.now(UTC)
        row.updated_by = updated_by
        await self.session.flush()
        return row

    async def active_policy_rules(
        self, org_id: UUID | None, workflow_type: WorkflowType
    ) -> Sequence[PolicyRule]:
        stmt = select(PolicyRule).where(
            PolicyRule.active.is_(True),
            PolicyRule.workflow_type == workflow_type.value,
        )
        if org_id:
            stmt = stmt.where(PolicyRule.org_id == org_id)
        return (await self.session.scalars(stmt)).all()
