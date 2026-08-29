"""Code-based PO validator. Design screens 6a (pass) and 6b (fail).

Deterministic Python -- an LLM is never consulted. Each check compares the
generated PO against the QUOTE SNAPSHOT rather than the live catalog, which is
what makes "supplier consistency" provable: if the PO says a price the vendor
never quoted, the check fails, regardless of what the catalog says today.

Every check reports expected vs actual so screen 6b can explain the failure
and the self-correction pass has something concrete to repair.

Checks are registered, not hard-coded into one function, so the reimbursement
workflow can run a different set (policy compliance) through the same engine.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from app.schemas.enums import ValidationCheckType, ValidationOutcome
from app.schemas.po import ValidationCheck, ValidationReport


@dataclass(slots=True)
class ValidationTarget:
    """Everything a check needs, decoupled from the ORM for testability."""

    workflow_id: UUID
    purchase_order_id: UUID | None
    currency: str
    budget: Decimal | None

    po_total: Decimal
    po_subtotal: Decimal
    po_tax: Decimal
    po_vendor_id: UUID | None
    po_vendor_name: str | None
    po_delivery_days: int | None
    po_warranty_months: int | None
    # [{name, quantity, unit_price, line_total}]
    po_lines: list[dict]

    # The snapshot the PO must agree with.
    quote_vendor_id: UUID | None
    quote_vendor_name: str | None
    quote_total: Decimal | None
    quote_delivery_days: int | None
    quote_warranty_months: int | None
    quote_lines: list[dict]

    # What the user actually asked for.
    requested_items: list[dict]     # [{name, quantity}]

    required_fields: tuple[str, ...] = (
        "po_number",
        "vendor_name",
        "total_amount",
        "currency",
    )
    present_fields: frozenset[str] = frozenset()

    def money(self, value: Decimal | None) -> str:
        return "—" if value is None else f"{self.currency} {value:,.2f}"


class Check(ABC):
    check_type: ValidationCheckType
    title: str

    @abstractmethod
    def run(self, target: ValidationTarget) -> ValidationCheck: ...

    def _result(
        self,
        outcome: ValidationOutcome,
        message: str,
        expected: str | None = None,
        actual: str | None = None,
    ) -> ValidationCheck:
        return ValidationCheck(
            check=self.check_type,
            title=self.title,
            outcome=outcome,
            expected=expected,
            actual=actual,
            message=message,
        )


class BudgetComplianceCheck(Check):
    check_type = ValidationCheckType.BUDGET_COMPLIANCE
    title = "Budget compliance"

    def run(self, target: ValidationTarget) -> ValidationCheck:
        if target.budget is None:
            return self._result(
                ValidationOutcome.WARNING,
                "No budget ceiling was specified for this request.",
            )
        if target.po_total <= target.budget:
            headroom = target.budget - target.po_total
            return self._result(
                ValidationOutcome.PASSED,
                f"Total {target.money(target.po_total)} is within the "
                f"{target.money(target.budget)} budget "
                f"({target.money(headroom)} remaining).",
                expected=f"<= {target.money(target.budget)}",
                actual=target.money(target.po_total),
            )
        return self._result(
            ValidationOutcome.FAILED,
            f"Total {target.money(target.po_total)} exceeds the "
            f"{target.money(target.budget)} budget by "
            f"{target.money(target.po_total - target.budget)}.",
            expected=f"<= {target.money(target.budget)}",
            actual=target.money(target.po_total),
        )


class QuantityCorrectnessCheck(Check):
    check_type = ValidationCheckType.QUANTITY_CORRECTNESS
    title = "Quantity correctness"

    def run(self, target: ValidationTarget) -> ValidationCheck:
        requested = {i["name"]: int(i["quantity"]) for i in target.requested_items}
        ordered: dict[str, int] = {}
        for line in target.po_lines:
            name = line.get("name") or line.get("description") or ""
            ordered[name] = ordered.get(name, 0) + int(line.get("quantity", 0))

        mismatches = []
        for name, qty in requested.items():
            got = ordered.get(name, 0)
            if got != qty:
                mismatches.append(f"{name}: expected {qty}, PO has {got}")

        if not mismatches:
            total = sum(requested.values())
            return self._result(
                ValidationOutcome.PASSED,
                f"All {len(requested)} line item(s) match the request "
                f"({total} unit(s) total).",
                expected=", ".join(f"{n} x {q}" for n, q in requested.items()),
                actual=", ".join(f"{n} x {q}" for n, q in ordered.items()),
            )
        return self._result(
            ValidationOutcome.FAILED,
            "Ordered quantities do not match the request: "
            + "; ".join(mismatches),
            expected=", ".join(f"{n} x {q}" for n, q in requested.items()),
            actual=", ".join(f"{n} x {q}" for n, q in ordered.items()),
        )


class SupplierConsistencyCheck(Check):
    """The PO must reproduce the quoted terms exactly.

    This is the check that price-snapshot integrity exists to make possible.
    """

    check_type = ValidationCheckType.SUPPLIER_CONSISTENCY
    title = "Supplier consistency"

    def run(self, target: ValidationTarget) -> ValidationCheck:
        problems: list[str] = []

        if (
            target.quote_vendor_id is not None
            and target.po_vendor_id != target.quote_vendor_id
        ):
            problems.append(
                f"supplier changed ({target.quote_vendor_name} quoted, "
                f"{target.po_vendor_name} on PO)"
            )
        if target.quote_total is not None and target.po_total != target.quote_total:
            problems.append(
                f"total {target.money(target.po_total)} != quoted "
                f"{target.money(target.quote_total)}"
            )
        if (
            target.quote_delivery_days is not None
            and target.po_delivery_days != target.quote_delivery_days
        ):
            problems.append(
                f"delivery {target.po_delivery_days}d != quoted "
                f"{target.quote_delivery_days}d"
            )
        if (
            target.quote_warranty_months is not None
            and target.po_warranty_months != target.quote_warranty_months
        ):
            problems.append(
                f"warranty {target.po_warranty_months}mo != quoted "
                f"{target.quote_warranty_months}mo"
            )

        quoted_prices = {
            ln.get("name"): ln.get("unit_price") for ln in target.quote_lines
        }
        for line in target.po_lines:
            name = line.get("name") or line.get("description")
            quoted = quoted_prices.get(name)
            if quoted is not None and line.get("unit_price") != quoted:
                problems.append(
                    f"{name} unit price {line.get('unit_price')} != quoted {quoted}"
                )

        if not problems:
            return self._result(
                ValidationOutcome.PASSED,
                f"PO terms match {target.quote_vendor_name}'s quoted snapshot.",
                expected=f"{target.quote_vendor_name} @ {target.money(target.quote_total)}",
                actual=f"{target.po_vendor_name} @ {target.money(target.po_total)}",
            )
        return self._result(
            ValidationOutcome.FAILED,
            "PO does not match the quoted terms: " + "; ".join(problems),
            expected=f"{target.quote_vendor_name} @ {target.money(target.quote_total)}",
            actual=f"{target.po_vendor_name} @ {target.money(target.po_total)}",
        )


class RequiredFieldsCheck(Check):
    check_type = ValidationCheckType.REQUIRED_FIELDS
    title = "Required fields complete"

    def run(self, target: ValidationTarget) -> ValidationCheck:
        missing = [f for f in target.required_fields if f not in target.present_fields]
        if not missing:
            return self._result(
                ValidationOutcome.PASSED,
                f"All {len(target.required_fields)} required fields are present.",
                expected=", ".join(target.required_fields),
                actual="all present",
            )
        return self._result(
            ValidationOutcome.FAILED,
            "Missing required field(s): " + ", ".join(missing),
            expected=", ".join(target.required_fields),
            actual=f"missing {', '.join(missing)}",
        )


class ArithmeticCheck(Check):
    """Subtotal + tax must equal the total, and lines must sum to subtotal."""

    check_type = ValidationCheckType.REQUIRED_FIELDS
    title = "Totals arithmetic"

    def run(self, target: ValidationTarget) -> ValidationCheck:
        line_sum = sum(
            (Decimal(str(ln.get("line_total", 0))) for ln in target.po_lines),
            Decimal("0"),
        )
        problems = []
        if target.po_subtotal != line_sum:
            problems.append(
                f"line items sum to {target.money(line_sum)}, "
                f"subtotal says {target.money(target.po_subtotal)}"
            )
        if target.po_total != target.po_subtotal + target.po_tax:
            problems.append(
                f"subtotal + tax = "
                f"{target.money(target.po_subtotal + target.po_tax)}, "
                f"total says {target.money(target.po_total)}"
            )
        if problems:
            return self._result(
                ValidationOutcome.FAILED,
                "; ".join(problems),
                expected=target.money(line_sum + target.po_tax),
                actual=target.money(target.po_total),
            )
        return self._result(
            ValidationOutcome.PASSED,
            f"Line items, subtotal and total agree "
            f"({target.money(target.po_total)}).",
            expected=target.money(line_sum + target.po_tax),
            actual=target.money(target.po_total),
        )


# --------------------------------------------------------------------------
# Registry + runner
# --------------------------------------------------------------------------
PROCUREMENT_CHECKS: tuple[Check, ...] = (
    BudgetComplianceCheck(),
    QuantityCorrectnessCheck(),
    SupplierConsistencyCheck(),
    ArithmeticCheck(),
    RequiredFieldsCheck(),
)


class Validator:
    """Runs a check set and assembles the report."""

    def __init__(self, checks: tuple[Check, ...] = PROCUREMENT_CHECKS) -> None:
        self.checks = checks

    def validate(
        self, target: ValidationTarget, *, attempt: int, max_attempts: int
    ) -> ValidationReport:
        results = [check.run(target) for check in self.checks]
        return ValidationReport(
            workflow_id=target.workflow_id,
            purchase_order_id=target.purchase_order_id,
            checks=results,
            attempt=attempt,
            max_attempts=max_attempts,
            validated_at=datetime.now(UTC),
        )
