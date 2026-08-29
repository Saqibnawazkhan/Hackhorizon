"""SQLAlchemy ORM models.

These mirror ``migrations/001_schema.sql`` exactly. The SQL file is the source
of truth (it also carries the CHECK constraints and RLS policies); these
classes exist so the repository layer has typed access without raw queries.

Kept in one module deliberately: the relationships are densely cross-linked,
and splitting them across files buys nothing but import cycles.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _pk() -> Mapped[UUID]:
    return mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)


TS = DateTime(timezone=True)
MONEY = Numeric(16, 2)


# ==========================================================================
# Org / users
# ==========================================================================
class Org(Base):
    __tablename__ = "orgs"

    id: Mapped[UUID] = _pk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="PKR")
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())


class User(Base):
    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    org_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("orgs.id", ondelete="SET NULL")
    )
    email: Mapped[str] = mapped_column(Text, nullable=False)
    full_name: Mapped[str | None] = mapped_column(Text)
    role: Mapped[str] = mapped_column(Text, nullable=False, default="employee")
    avatar_initials: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(TS)


# ==========================================================================
# Vendors
# ==========================================================================
class Vendor(Base):
    __tablename__ = "vendors"

    id: Mapped[UUID] = _pk()
    org_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE")
    )
    user_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), unique=True
    )
    created_by: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    name: Mapped[str] = mapped_column(Text, nullable=False)
    legal_name: Mapped[str | None] = mapped_column(Text)
    email: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(Text)
    address: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(Text)

    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    verified_at: Mapped[datetime | None] = mapped_column(TS)
    verified_by: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    suspended_reason: Mapped[str | None] = mapped_column(Text)

    default_delivery_days: Mapped[int | None] = mapped_column(Integer)
    default_warranty_months: Mapped[int | None] = mapped_column(Integer)

    reliability_score: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    orders_fulfilled: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    on_time_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 4))
    quantity_accuracy: Mapped[Decimal | None] = mapped_column(Numeric(5, 4))
    cancellations: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    late_deliveries: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reliability_computed_at: Mapped[datetime | None] = mapped_column(TS)

    last_published_at: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(TS)

    catalog_items: Mapped[list[CatalogItem]] = relationship(
        back_populates="vendor",
        cascade="all, delete-orphan",
        # Never read through the ORM -- CatalogRepository queries directly.
        # As selectin this pulled a whole catalog per vendor fetched.
        lazy="raise",
    )
    flags: Mapped[list[VendorFlagRow]] = relationship(
        back_populates="vendor",
        cascade="all, delete-orphan",
        # Routers call VendorRepository.open_flags() instead.
        lazy="raise",
    )


class VendorFlagRow(Base):
    __tablename__ = "vendor_flags"

    id: Mapped[UUID] = _pk()
    vendor_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE")
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    detail: Mapped[str] = mapped_column(Text, nullable=False)
    threshold: Mapped[str] = mapped_column(Text, nullable=False)
    raised_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(TS)
    resolved_by: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    vendor: Mapped[Vendor] = relationship(back_populates="flags")


class CatalogItem(Base):
    __tablename__ = "catalog_items"

    id: Mapped[UUID] = _pk()
    vendor_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE")
    )

    sku: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(Text)
    brand: Mapped[str | None] = mapped_column(Text)

    price: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    sale_price: Mapped[Decimal | None] = mapped_column(MONEY)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="PKR")
    stock: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    delivery_days: Mapped[int | None] = mapped_column(Integer)
    warranty_months: Mapped[int | None] = mapped_column(Integer)

    visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    source: Mapped[str] = mapped_column(Text, nullable=False, default="manual")
    published_at: Mapped[datetime | None] = mapped_column(TS)
    has_unpublished_changes: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(TS)

    vendor: Mapped[Vendor] = relationship(back_populates="catalog_items")


# ==========================================================================
# Workflows
# ==========================================================================
class Workflow(Base):
    __tablename__ = "workflows"

    id: Mapped[UUID] = _pk()
    org_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE")
    )
    requester_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )

    title: Mapped[str] = mapped_column(Text, nullable=False)
    request_text: Mapped[str] = mapped_column(Text, nullable=False)
    workflow_type: Mapped[str] = mapped_column(Text, nullable=False)
    entities_json: Mapped[dict | None] = mapped_column(JSONB)
    plan_json: Mapped[list | None] = mapped_column(JSONB)
    summary: Mapped[str | None] = mapped_column(Text)

    status: Mapped[str] = mapped_column(Text, nullable=False, default="draft")
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="PKR")
    budget: Mapped[Decimal | None] = mapped_column(MONEY)
    total_amount: Mapped[Decimal | None] = mapped_column(MONEY)

    current_step_order: Mapped[int | None] = mapped_column(Integer)
    self_correction_attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    planner_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    escalation_reason: Mapped[str | None] = mapped_column(Text)
    #: Why the agent chose the vendor it chose. Every autonomous decision has
    #: to carry one, and the approver is shown it before signing off.
    justification: Mapped[str | None] = mapped_column(Text)

    checkpoint_thread_id: Mapped[str | None] = mapped_column(Text, unique=True)
    idempotency_key: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(TS)
    completed_at: Mapped[datetime | None] = mapped_column(TS)
    duration_ms: Mapped[int | None] = mapped_column(Integer)

    items: Mapped[list[WorkflowItem]] = relationship(
        back_populates="workflow",
        cascade="all, delete-orphan",
        # The agent reads items from entities_json, not this relationship.
        lazy="raise",
    )
    steps: Mapped[list[Step]] = relationship(
        back_populates="workflow",
        cascade="all, delete-orphan",
        # Always fetched via StepRepository.for_workflow().
        lazy="raise",
        order_by="Step.step_order",
    )


class WorkflowItem(Base):
    __tablename__ = "workflow_items"

    id: Mapped[UUID] = _pk()
    workflow_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workflows.id", ondelete="CASCADE")
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit: Mapped[str | None] = mapped_column(Text)
    specification: Mapped[str | None] = mapped_column(Text)
    category_hint: Mapped[str | None] = mapped_column(Text)

    workflow: Mapped[Workflow] = relationship(back_populates="items")


class Step(Base):
    __tablename__ = "steps"

    id: Mapped[UUID] = _pk()
    workflow_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workflows.id", ondelete="CASCADE")
    )
    step_order: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    tool_name: Mapped[str | None] = mapped_column(Text)

    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_retries: Mapped[int] = mapped_column(Integer, nullable=False, default=3)

    input_json: Mapped[dict | None] = mapped_column(JSONB)
    output_json: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)

    started_at: Mapped[datetime | None] = mapped_column(TS)
    completed_at: Mapped[datetime | None] = mapped_column(TS)
    duration_ms: Mapped[int | None] = mapped_column(Integer)

    workflow: Mapped[Workflow] = relationship(back_populates="steps")
    tool_calls: Mapped[list[ToolCall]] = relationship(
        back_populates="step",
        cascade="all, delete-orphan",
        # Only the workflow-detail endpoint needs these; it asks for them
        # explicitly. Eager-loading them cost a query on every step touch.
        lazy="raise",
    )


class ToolCall(Base):
    __tablename__ = "tool_calls"

    id: Mapped[UUID] = _pk()
    workflow_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workflows.id", ondelete="CASCADE")
    )
    step_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("steps.id", ondelete="CASCADE")
    )
    tool_name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    input_json: Mapped[dict | None] = mapped_column(JSONB)
    output_json: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(TS)

    step: Mapped[Step] = relationship(back_populates="tool_calls")


class WorkflowEvent(Base):
    """Durable WS event log -- powers replay for a phone that reconnects."""

    __tablename__ = "workflow_events"

    # The primary key IS the replay cursor. Postgres assigns it, so it is
    # monotonic, needs no read to compute, and two concurrent writers cannot
    # collide on it -- which a MAX(seq)+1 scheme could, and did.
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    workflow_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workflows.id", ondelete="CASCADE")
    )
    #: Legacy per-workflow counter, kept so historic rows still read. Unwritten.
    seq: Mapped[int | None] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())


# ==========================================================================
# Quotes -- snapshot rows
# ==========================================================================
class Quote(Base):
    __tablename__ = "quotes"

    id: Mapped[UUID] = _pk()
    workflow_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workflows.id", ondelete="CASCADE")
    )
    vendor_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="RESTRICT")
    )
    vendor_name: Mapped[str] = mapped_column(Text, nullable=False)

    status: Mapped[str] = mapped_column(Text, nullable=False, default="quoted")
    exclusion_reason: Mapped[str | None] = mapped_column(Text)

    total_amount: Mapped[Decimal | None] = mapped_column(MONEY)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="PKR")
    delivery_days: Mapped[int | None] = mapped_column(Integer)
    warranty_months: Mapped[int | None] = mapped_column(Integer)

    items_covered: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    items_requested: Mapped[int] = mapped_column(Integer, nullable=False)

    score_total: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    score_json: Mapped[dict | None] = mapped_column(JSONB)
    confidence_percent: Mapped[int | None] = mapped_column(Integer)
    missing_fields: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list
    )

    reliability_score: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    reliability_has_history: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )

    snapshot_taken_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())

    # Kept eager: every path that loads a quote reads its lines.
    lines: Mapped[list[QuoteLine]] = relationship(
        back_populates="quote", cascade="all, delete-orphan", lazy="selectin"
    )


class QuoteLine(Base):
    __tablename__ = "quote_lines"

    id: Mapped[UUID] = _pk()
    quote_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("quotes.id", ondelete="CASCADE")
    )
    workflow_item_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workflow_items.id", ondelete="SET NULL")
    )
    catalog_item_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("catalog_items.id", ondelete="SET NULL")
    )

    request_item_name: Mapped[str] = mapped_column(Text, nullable=False)
    matched_title: Mapped[str | None] = mapped_column(Text)
    sku: Mapped[str | None] = mapped_column(Text)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    stock_on_hand: Mapped[int | None] = mapped_column(Integer)

    unit_price: Mapped[Decimal | None] = mapped_column(MONEY)
    line_total: Mapped[Decimal | None] = mapped_column(MONEY)
    delivery_days: Mapped[int | None] = mapped_column(Integer)
    warranty_months: Mapped[int | None] = mapped_column(Integer)

    quote: Mapped[Quote] = relationship(back_populates="lines")


# ==========================================================================
# Purchase orders
# ==========================================================================
class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id: Mapped[UUID] = _pk()
    po_number: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    workflow_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workflows.id", ondelete="CASCADE")
    )
    vendor_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="RESTRICT")
    )
    quote_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("quotes.id", ondelete="RESTRICT")
    )

    subtotal: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    tax: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=Decimal("0"))
    total_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="PKR")

    delivery_days: Mapped[int | None] = mapped_column(Integer)
    expected_delivery_date: Mapped[date | None] = mapped_column(Date)
    warranty_months: Mapped[int | None] = mapped_column(Integer)
    payment_terms: Mapped[str | None] = mapped_column(Text)
    delivery_address: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)

    delivery_status: Mapped[str] = mapped_column(
        Text, nullable=False, default="issued"
    )
    delivered_at: Mapped[datetime | None] = mapped_column(TS)
    quantity_delivered: Mapped[int | None] = mapped_column(Integer)

    pdf_path: Mapped[str | None] = mapped_column(Text)
    generation_attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # -- Buyer-side close-out (migration 010) -----------------------------
    # delivery_status above is the SUPPLIER's account of this order. These are
    # the BUYER's, and they are separate on purpose: a vendor marking an order
    # delivered and a buyer confirming it arrived are different claims.
    closed_at: Mapped[datetime | None] = mapped_column(TS)
    closed_by: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    closure_outcome: Mapped[str | None] = mapped_column(Text)
    closure_note: Mapped[str | None] = mapped_column(Text)
    #: What the buyer actually counted, against the ordered quantity.
    received_quantity: Mapped[int | None] = mapped_column(Integer)

    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(TS)

    line_items: Mapped[list[POLineItem]] = relationship(
        back_populates="purchase_order",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="POLineItem.line_number",
    )


class POLineItem(Base):
    __tablename__ = "po_line_items"

    id: Mapped[UUID] = _pk()
    purchase_order_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("purchase_orders.id", ondelete="CASCADE")
    )
    quote_line_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("quote_lines.id", ondelete="SET NULL")
    )
    catalog_item_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("catalog_items.id", ondelete="SET NULL")
    )

    line_number: Mapped[int] = mapped_column(Integer, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    sku: Mapped[str | None] = mapped_column(Text)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    line_total: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    delivery_days: Mapped[int | None] = mapped_column(Integer)
    warranty_months: Mapped[int | None] = mapped_column(Integer)

    purchase_order: Mapped[PurchaseOrder] = relationship(back_populates="line_items")


class POFulfilmentEvent(Base):
    """Raw facts. Reliability is derived from these, never typed in."""

    __tablename__ = "po_fulfilment_events"

    id: Mapped[UUID] = _pk()
    purchase_order_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("purchase_orders.id", ondelete="CASCADE")
    )
    vendor_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE")
    )
    event: Mapped[str] = mapped_column(Text, nullable=False)
    expected_date: Mapped[date | None] = mapped_column(Date)
    actual_date: Mapped[date | None] = mapped_column(Date)
    days_late: Mapped[int | None] = mapped_column(Integer)
    quantity_expected: Mapped[int | None] = mapped_column(Integer)
    quantity_actual: Mapped[int | None] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())


# ==========================================================================
# Validation / approvals / policy
# ==========================================================================
class ValidationReportRow(Base):
    __tablename__ = "validation_reports"

    id: Mapped[UUID] = _pk()
    workflow_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workflows.id", ondelete="CASCADE")
    )
    purchase_order_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("purchase_orders.id", ondelete="CASCADE")
    )
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    passed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    checks_json: Mapped[list] = mapped_column(JSONB, nullable=False)
    validated_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())


class Approval(Base):
    __tablename__ = "approvals"

    id: Mapped[UUID] = _pk()
    workflow_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workflows.id", ondelete="CASCADE")
    )
    purchase_order_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("purchase_orders.id", ondelete="CASCADE")
    )
    org_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE")
    )

    decision: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    approver_role: Mapped[str] = mapped_column(Text, nullable=False, default="admin")
    requested_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    decided_at: Mapped[datetime | None] = mapped_column(TS)
    decided_by: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    comment: Mapped[str | None] = mapped_column(Text)
    idempotency_key: Mapped[str | None] = mapped_column(Text)


class PolicyRule(Base):
    __tablename__ = "policy_rules"

    id: Mapped[UUID] = _pk()
    org_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    rule_type: Mapped[str] = mapped_column(Text, nullable=False)
    workflow_type: Mapped[str] = mapped_column(
        Text, nullable=False, default="reimbursement"
    )
    category: Mapped[str | None] = mapped_column(Text)
    numeric_value: Mapped[Decimal | None] = mapped_column(MONEY)
    currency: Mapped[str | None] = mapped_column(String(3))
    text_value: Mapped[str | None] = mapped_column(Text)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    created_by: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )


class ScoringWeightRow(Base):
    __tablename__ = "scoring_weights"

    org_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE"),
        primary_key=True,
    )
    weight_price: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    weight_delivery: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    weight_warranty: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    weight_reliability: Mapped[Decimal] = mapped_column(
        Numeric(4, 3), nullable=False, default=Decimal("0")
    )
    updated_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    updated_by: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )


# ==========================================================================
# Vendor portal
# ==========================================================================
class ImportJob(Base):
    __tablename__ = "import_jobs"

    id: Mapped[UUID] = _pk()
    vendor_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE")
    )
    created_by: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    filename: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="uploaded")
    mapping_json: Mapped[list | None] = mapped_column(JSONB)
    total_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    committed_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rows_missing_terms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    committed_at: Mapped[datetime | None] = mapped_column(TS)

    rows: Mapped[list[ImportJobRow]] = relationship(
        back_populates="job",
        cascade="all, delete-orphan",
        lazy="raise",
    )


class ImportJobRow(Base):
    __tablename__ = "import_job_rows"

    id: Mapped[UUID] = _pk()
    import_job_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("import_jobs.id", ondelete="CASCADE")
    )
    row_number: Mapped[int] = mapped_column(Integer, nullable=False)
    raw_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    parsed_json: Mapped[dict | None] = mapped_column(JSONB)
    errors_json: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    is_duplicate_sku: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    committed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    catalog_item_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("catalog_items.id", ondelete="SET NULL")
    )

    job: Mapped[ImportJob] = relationship(back_populates="rows")


class CatalogConnection(Base):
    __tablename__ = "catalog_connections"

    id: Mapped[UUID] = _pk()
    vendor_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE")
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    store_url: Mapped[str | None] = mapped_column(Text)
    credentials_ref: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="disconnected")
    auto_sync_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    sync_interval_minutes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=60
    )
    last_sync_at: Mapped[datetime | None] = mapped_column(TS)
    last_sync_item_count: Mapped[int | None] = mapped_column(Integer)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())


class Notification(Base):
    """Durable inbox behind the bell.

    Written alongside every push, to the same recipients. One row per person,
    because read state belongs to a person and not to the event -- one admin
    reading an approval request must not clear it from another admin's bell.
    """

    __tablename__ = "notifications"

    id: Mapped[UUID] = _pk()
    user_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    org_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    deep_link: Mapped[str | None] = mapped_column(Text)
    workflow_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workflows.id", ondelete="CASCADE")
    )
    read_at: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())


class FcmToken(Base):
    __tablename__ = "fcm_tokens"

    id: Mapped[UUID] = _pk()
    user_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    token: Mapped[str] = mapped_column(Text, nullable=False)
    platform: Mapped[str] = mapped_column(Text, nullable=False, default="android")
    device_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())


# ==========================================================================
# Request for quotation
#
# The path out of the dead end. When budget_filter finds no qualifying vendor
# the workflow escalates, and until now that was terminal -- the catalog held
# no answer and there was no way to ask for one.
#
# The agent is NOT involved. It still only reads the catalog, which is what
# keeps a run deterministic and replayable. The buyer asks, vendors answer,
# each answer is written into that vendor's catalog, and the ordinary
# catalog_query path finds it on the next run.
# ==========================================================================
class QuoteRequest(Base):
    __tablename__ = "quote_requests"

    id: Mapped[UUID] = _pk()
    workflow_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workflows.id", ondelete="CASCADE")
    )
    org_id: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("orgs.id", ondelete="CASCADE")
    )
    requested_by: Mapped[UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    #: Carried from workflows.escalation_reason. "Nothing in the catalog
    #: matches" reads very differently to a vendor than "everyone was over
    #: budget", and the vendor deserves to know which it was.
    reason: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)

    #: The requested lines, snapshotted at request time -- for the same reason
    #: a quote snapshots price: the request a vendor answered must not change
    #: under them.
    items_json: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)

    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="PKR")
    budget: Mapped[Decimal | None] = mapped_column(MONEY)

    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    #: Without a deadline an escalated workflow parks forever.
    closes_at: Mapped[datetime | None] = mapped_column(TS)

    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    closed_at: Mapped[datetime | None] = mapped_column(TS)

    responses: Mapped[list[QuoteRequestResponse]] = relationship(
        back_populates="quote_request",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="QuoteRequestResponse.invited_at",
    )


class QuoteRequestResponse(Base):
    """One row per (request, vendor), created at INVITE time.

    Created on invitation rather than on reply so the buyer can see "asked 4,
    heard from 2". A table of replies alone silently hides everyone who did
    not answer, which is exactly what the buyer needs to know.
    """

    __tablename__ = "quote_request_responses"

    id: Mapped[UUID] = _pk()
    quote_request_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("quote_requests.id", ondelete="CASCADE")
    )
    vendor_id: Mapped[UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE")
    )

    status: Mapped[str] = mapped_column(Text, nullable=False, default="invited")

    #: One entry per requested line: request_item_name, sku, title,
    #: unit_price, quantity, delivery_days, warranty_months, available.
    #: A document rather than columns because the shape follows the request's
    #: line items, not a fixed schema.
    lines_json: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)

    total_amount: Mapped[Decimal | None] = mapped_column(MONEY)
    currency: Mapped[str | None] = mapped_column(String(3))
    delivery_days: Mapped[int | None] = mapped_column(Integer)
    warranty_months: Mapped[int | None] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text)
    decline_reason: Mapped[str | None] = mapped_column(Text)

    #: True once the reply has been written into the vendor's catalog. That
    #: write is what makes the offer visible to catalog_query.
    published_to_catalog: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )

    invited_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    responded_at: Mapped[datetime | None] = mapped_column(TS)

    quote_request: Mapped[QuoteRequest] = relationship(back_populates="responses")


__all__ = [
    "Base", "Org", "User", "Vendor", "VendorFlagRow", "CatalogItem",
    "Workflow", "WorkflowItem", "Step", "ToolCall", "WorkflowEvent",
    "Quote", "QuoteLine", "PurchaseOrder", "POLineItem", "POFulfilmentEvent",
    "ValidationReportRow", "Approval", "PolicyRule", "ScoringWeightRow",
    "ImportJob", "ImportJobRow", "CatalogConnection", "FcmToken",
    "Notification", "QuoteRequest", "QuoteRequestResponse",
]
