"""Quote requests and their responses.

Every query here is scoped either to an organisation (buyer side) or to the
vendor profile derived from the authenticated identity (vendor side). A vendor
can never reach another vendor's response row, which is what stops one
supplier reading what a competitor quoted.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Sequence
from uuid import UUID

from sqlalchemy import func, select

from app.db.models import QuoteRequest, QuoteRequestResponse, Vendor, Workflow
from app.repositories.base import BaseRepository
from app.schemas.enums import (
    QuoteRequestStatus,
    QuoteResponseStatus,
    VendorStatus,
)


class QuoteRequestRepository(BaseRepository[QuoteRequest]):
    model = QuoteRequest

    # ----------------------------------------------------------------------
    # Buyer side
    # ----------------------------------------------------------------------
    async def open_for_workflow(self, workflow_id: UUID) -> QuoteRequest | None:
        """The live request for a workflow, if there is one.

        A workflow has at most one open request at a time. Asking twice should
        reach the same suppliers with the same question, not fragment the
        replies across two rows the buyer then has to reconcile.
        """
        return await self.session.scalar(
            select(QuoteRequest)
            .where(
                QuoteRequest.workflow_id == workflow_id,
                QuoteRequest.status == QuoteRequestStatus.OPEN.value,
            )
            .order_by(QuoteRequest.created_at.desc())
            .limit(1)
        )

    async def latest_for_workflow(self, workflow_id: UUID) -> QuoteRequest | None:
        return await self.session.scalar(
            select(QuoteRequest)
            .where(QuoteRequest.workflow_id == workflow_id)
            .order_by(QuoteRequest.created_at.desc())
            .limit(1)
        )

    async def invitable_vendor_ids(self, org_id: UUID | None) -> list[UUID]:
        """Who is worth asking.

        Verified and flagged vendors only. A flagged vendor is still a real
        supplier -- the flag is a performance warning the buyer sees on the
        comparison, not a ban -- but a pending one has not been checked by an
        administrator yet, and a suspended one was stopped deliberately.
        """
        stmt = select(Vendor.id).where(
            Vendor.status.in_([VendorStatus.VERIFIED.value, VendorStatus.FLAGGED.value])
        )
        if org_id:
            stmt = stmt.where(Vendor.org_id == org_id)
        return list((await self.session.scalars(stmt.order_by(Vendor.name))).all())

    async def create_request(
        self,
        *,
        workflow_id: UUID,
        org_id: UUID | None,
        requested_by: UUID | None,
        vendor_ids: Sequence[UUID],
        reason: str | None,
        note: str | None,
        items: list[dict[str, Any]],
        currency: str,
        budget: Decimal | None,
        respond_within_hours: int,
    ) -> QuoteRequest:
        request = QuoteRequest(
            workflow_id=workflow_id,
            org_id=org_id,
            requested_by=requested_by,
            reason=reason,
            note=note,
            items_json=items,
            currency=currency,
            budget=budget,
            status=QuoteRequestStatus.OPEN.value,
            closes_at=datetime.now(UTC) + timedelta(hours=respond_within_hours),
        )
        self.session.add(request)
        await self.session.flush()

        # One row per invitee, created now rather than on reply, so the buyer
        # can see who was asked and has said nothing.
        for vendor_id in dict.fromkeys(vendor_ids):
            self.session.add(
                QuoteRequestResponse(
                    quote_request_id=request.id,
                    vendor_id=vendor_id,
                    status=QuoteResponseStatus.INVITED.value,
                )
            )
        await self.session.flush()
        return request

    async def vendor_names(self, request: QuoteRequest) -> dict[UUID, str]:
        """Vendor id → name for one request, in a single query."""
        ids = [r.vendor_id for r in request.responses]
        if not ids:
            return {}
        rows = (
            await self.session.execute(
                select(Vendor.id, Vendor.name).where(Vendor.id.in_(ids))
            )
        ).all()
        return {row[0]: row[1] for row in rows}

    async def close(self, request: QuoteRequest) -> QuoteRequest:
        request.status = QuoteRequestStatus.CLOSED.value
        request.closed_at = datetime.now(UTC)
        await self.session.flush()
        return request

    # ----------------------------------------------------------------------
    # Vendor side
    # ----------------------------------------------------------------------
    async def for_vendor(
        self, vendor_id: UUID, *, include_closed: bool = False
    ) -> list[tuple[QuoteRequest, QuoteRequestResponse, str | None]]:
        """Requests addressed to this vendor, newest first.

        Returns the request, this vendor's own row of it, and the workflow
        title. Never any other vendor's response.
        """
        stmt = (
            select(QuoteRequest, QuoteRequestResponse, Workflow.title)
            .join(
                QuoteRequestResponse,
                QuoteRequestResponse.quote_request_id == QuoteRequest.id,
            )
            .outerjoin(Workflow, Workflow.id == QuoteRequest.workflow_id)
            .where(QuoteRequestResponse.vendor_id == vendor_id)
        )
        if not include_closed:
            stmt = stmt.where(QuoteRequest.status == QuoteRequestStatus.OPEN.value)
        rows = (await self.session.execute(stmt.order_by(QuoteRequest.created_at.desc()))).all()
        return [(row[0], row[1], row[2]) for row in rows]

    async def response_for(
        self, request_id: UUID, vendor_id: UUID
    ) -> QuoteRequestResponse | None:
        """This vendor's row of a request -- the only one they may touch."""
        return await self.session.scalar(
            select(QuoteRequestResponse).where(
                QuoteRequestResponse.quote_request_id == request_id,
                QuoteRequestResponse.vendor_id == vendor_id,
            )
        )

    async def open_invite_count(self, vendor_id: UUID) -> int:
        return (
            await self.session.scalar(
                select(func.count())
                .select_from(QuoteRequestResponse)
                .join(
                    QuoteRequest,
                    QuoteRequest.id == QuoteRequestResponse.quote_request_id,
                )
                .where(
                    QuoteRequestResponse.vendor_id == vendor_id,
                    QuoteRequestResponse.status == QuoteResponseStatus.INVITED.value,
                    QuoteRequest.status == QuoteRequestStatus.OPEN.value,
                )
            )
        ) or 0

    async def expire_overdue(
        self, org_id: UUID | None = None, *, vendor_id: UUID | None = None
    ) -> int:
        """Mark past-deadline requests expired.

        Called opportunistically when a request is read rather than by a
        scheduler: this project has no worker, and a status that only becomes
        true when someone looks is still true when it matters.

        SCOPED TO ONE ORG. Unscoped, one buyer opening their own workflow
        expired every overdue quote request belonging to every other
        organisation in the database -- a read on one tenant silently writing
        to another. Callers that genuinely mean "everything" pass None
        explicitly, and nothing in the request path does.
        """
        now = datetime.now(UTC)
        stmt = select(QuoteRequest).where(
            QuoteRequest.status == QuoteRequestStatus.OPEN.value,
            QuoteRequest.closes_at.is_not(None),
            QuoteRequest.closes_at < now,
        )
        if org_id is not None:
            stmt = stmt.where(QuoteRequest.org_id == org_id)
        if vendor_id is not None:
            # A vendor's own view: only requests they were actually invited
            # to. Their org is the buyer's org only by coincidence, so org
            # scoping is the wrong axis here.
            stmt = stmt.where(
                QuoteRequest.id.in_(
                    select(QuoteRequestResponse.quote_request_id).where(
                        QuoteRequestResponse.vendor_id == vendor_id
                    )
                )
            )
        overdue = (await self.session.scalars(stmt)).all()
        for request in overdue:
            request.status = QuoteRequestStatus.EXPIRED.value
            request.closed_at = now
        if overdue:
            await self.session.flush()
        return len(overdue)
