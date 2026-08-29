"""Enumerations shared by the API schemas, the ORM models and the SQL DDL.

These values are the contract. The Postgres CHECK constraints in
``migrations/001_schema.sql`` list exactly the same strings, and the Flutter
client maps each to a status pill. Adding a value means touching all three --
so the migration file is generated from this module by
``scripts/gen_enum_sql.py`` to keep them from drifting.
"""
from __future__ import annotations

from enum import StrEnum


class UserRole(StrEnum):
    EMPLOYEE = "employee"
    ADMIN = "admin"
    VENDOR = "vendor"


class WorkflowType(StrEnum):
    """Inferred by the planner from free text alone -- never sent by the client."""

    PROCUREMENT = "procurement"
    REIMBURSEMENT = "reimbursement"


class WorkflowStatus(StrEnum):
    DRAFT = "draft"                      # plan generated, awaiting user confirm (2a -> 3a)
    RUNNING = "running"                  # design pill: "In Progress"
    AWAITING_APPROVAL = "awaiting_approval"   # design pill: "Pending Approval"
    APPROVED = "approved"
    REJECTED = "rejected"
    COMPLETED = "completed"              # design pill: "Done"
    FAILED = "failed"
    ESCALATED = "escalated"              # self-correction exhausted, or no vendors

    @property
    def is_terminal(self) -> bool:
        return self in {
            WorkflowStatus.COMPLETED,
            WorkflowStatus.REJECTED,
            WorkflowStatus.FAILED,
        }


class StepStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    RETRYING = "retrying"                # design screen 4b
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class ToolCallStatus(StrEnum):
    SUCCESS = "success"
    FAILED = "failed"
    RETRIED = "retried"
    TIMEOUT = "timeout"


class VendorStatus(StrEnum):
    PENDING = "pending"                  # employee-added, awaiting admin verification
    VERIFIED = "verified"
    SUSPENDED = "suspended"
    FLAGGED = "flagged"                  # auto-flagged by the monitoring job (18a)


class QuoteStatus(StrEnum):
    QUOTED = "quoted"
    EXCLUDED_BUDGET = "excluded_budget"  # "Exceeds budget -- excluded" (5a / 11a)
    EXCLUDED_COVERAGE = "excluded_coverage"
    EXCLUDED_STOCK = "excluded_stock"
    SELECTED = "selected"


class ValidationCheckType(StrEnum):
    BUDGET_COMPLIANCE = "budget_compliance"
    QUANTITY_CORRECTNESS = "quantity_correctness"
    SUPPLIER_CONSISTENCY = "supplier_consistency"
    REQUIRED_FIELDS = "required_fields"
    POLICY_COMPLIANCE = "policy_compliance"   # reimbursement workflow


class ValidationOutcome(StrEnum):
    PASSED = "passed"
    FAILED = "failed"
    WARNING = "warning"


class ApprovalDecision(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class PODeliveryStatus(StrEnum):
    ISSUED = "issued"
    ACKNOWLEDGED = "acknowledged"
    IN_TRANSIT = "in_transit"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"

    @property
    def is_terminal(self) -> bool:
        return self in {PODeliveryStatus.DELIVERED, PODeliveryStatus.CANCELLED}

    def can_move_to(self, target: "PODeliveryStatus") -> bool:
        """Whether a vendor may move an order from this state to ``target``.

        Fulfilment only moves forward. Without this any status could be set
        from any other, repeatedly -- an order could go back to issued after
        delivery, or be delivered twice, and each write appended another
        fulfilment event. Those events are what a reliability score is meant
        to be computed from, so letting them be fabricated makes the score
        meaningless.

        Cancelling is allowed right up until delivery, because a supplier
        genuinely can pull out; after delivery it is a dispute, not a status.
        """
        if self.is_terminal:
            return False
        if target is PODeliveryStatus.CANCELLED:
            return True
        order = [
            PODeliveryStatus.ISSUED,
            PODeliveryStatus.ACKNOWLEDGED,
            PODeliveryStatus.IN_TRANSIT,
            PODeliveryStatus.DELIVERED,
        ]
        if target not in order:
            return False
        return order.index(target) > order.index(self)

    @property
    def next_states(self) -> list["PODeliveryStatus"]:
        """What a vendor may do next. Drives the portal's action chips."""
        return [s for s in PODeliveryStatus if self.can_move_to(s)]


class ScoringStrategyName(StrEnum):
    SINGLE_ITEM = "single_item"          # MODE A
    MULTI_ITEM = "multi_item"            # MODE B
    POLICY_COMPLIANCE = "policy_compliance"


class ImportJobStatus(StrEnum):
    UPLOADED = "uploaded"
    PREVIEWED = "previewed"
    COMMITTED = "committed"
    PARTIALLY_COMMITTED = "partially_committed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class CatalogSourceKind(StrEnum):
    """Adapters behind the CatalogSource interface."""

    MANUAL = "manual"
    CSV_IMPORT = "csv_import"
    API_SYNC = "api_sync"
    #: Written by a vendor answering a quote request. Publishing the answer
    #: into the catalog is what makes it visible to catalog_query, and so to
    #: the agent on the next run -- the agent still only ever reads.
    RFQ = "rfq"


class QuoteRequestStatus(StrEnum):
    """Lifecycle of a buyer's request for quotation."""

    OPEN = "open"
    CLOSED = "closed"
    CANCELLED = "cancelled"
    #: Past ``closes_at``. Responses are refused; the buyer proceeds with
    #: whatever arrived rather than waiting on a vendor who is not coming.
    EXPIRED = "expired"


class QuoteResponseStatus(StrEnum):
    """One vendor's position on one quote request.

    ``INVITED`` exists so the buyer can see who was asked and has not
    answered. Silence is information, and a table of replies alone hides it.
    """

    INVITED = "invited"
    RESPONDED = "responded"
    DECLINED = "declined"


class POClosureOutcome(StrEnum):
    """The BUYER's verdict on a delivered order.

    Deliberately separate from ``PODeliveryStatus``, which is the SUPPLIER's
    account of the same order. A vendor marking something delivered and a
    buyer confirming it arrived are different claims, and reliability scoring
    is only defensible when it can tell them apart.
    """

    COMPLETED = "completed"
    COMPLETED_WITH_ISSUES = "completed_with_issues"
    CANCELLED = "cancelled"


class CatalogProvider(StrEnum):
    SHOPIFY = "shopify"
    WOOCOMMERCE = "woocommerce"
    GENERIC_REST = "generic_rest"


class ConnectionStatus(StrEnum):
    DISCONNECTED = "disconnected"
    CONNECTED = "connected"
    ERROR = "error"
    SYNCING = "syncing"


class PolicyRuleType(StrEnum):
    MAX_AMOUNT = "max_amount"
    MAX_PER_DAY = "max_per_day"
    RECEIPT_REQUIRED = "receipt_required"
    CATEGORY_ALLOWED = "category_allowed"
    ADVANCE_NOTICE_DAYS = "advance_notice_days"


class VendorFlagReason(StrEnum):
    LATE_DELIVERIES = "late_deliveries"
    LOW_ON_TIME_RATE = "low_on_time_rate"
    CANCELLATIONS = "cancellations"
    QUANTITY_SHORTFALL = "quantity_shortfall"


class WSEventType(StrEnum):
    """WebSocket event envelope discriminator."""

    WORKFLOW_STATUS_CHANGED = "workflow.status_changed"
    STEP_STARTED = "step.started"
    STEP_COMPLETED = "step.completed"
    STEP_FAILED = "step.failed"
    STEP_RETRYING = "step.retrying"
    TOOL_CALLED = "tool.called"
    COMPARISON_READY = "comparison.ready"
    VALIDATION_RESULT = "validation.result"
    SELF_CORRECTION_STARTED = "selfcorrection.started"
    APPROVAL_REQUIRED = "approval.required"
    WORKFLOW_COMPLETED = "workflow.completed"
    WORKFLOW_ESCALATED = "workflow.escalated"
    HEARTBEAT = "heartbeat"
