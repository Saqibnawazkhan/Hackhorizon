"""Run one complete procurement workflow end to end against the real database.

    python scripts/demo_run.py
    python scripts/demo_run.py --multi        # the 3-line-item mixed order
    python scripts/demo_run.py --over-budget  # force the flag_for_human branch

Bypasses the planner (which needs ANTHROPIC_WORKSPACE_ID) by seeding the
entities directly, so everything downstream -- quoting, snapshotting, scoring,
PO generation, validation and the human gate -- is exercised for real.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from decimal import Decimal
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _winloop import install as _install_winloop  # noqa: E402

_install_winloop()

from app.agent.orchestrator import graph as G  # noqa: E402
from app.agent.orchestrator.template import for_workflow_type  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.db.session import session_scope  # noqa: E402
from app.repositories.procurement_repo import (  # noqa: E402
    ApprovalRepository,
    PurchaseOrderRepository,
    QuoteRepository,
    ValidationRepository,
)
from app.repositories.workflow_repo import (  # noqa: E402
    StepRepository,
    WorkflowRepository,
)
from app.schemas.enums import ApprovalDecision, WorkflowStatus, WorkflowType  # noqa: E402

ORG = UUID("00000000-0000-0000-0000-0000000000a1")

SINGLE = {
    "text": "Create a purchase request for 50 laptops under PKR 10 million, "
            "compare three suppliers, identify the best option, prepare the "
            "purchase order, and send it for approval.",
    "budget": Decimal("10000000"),
    "items": [{"name": "laptops", "quantity": 50}],
    "title": "Laptop procurement — 50 units",
}
MULTI = {
    "text": "50 laptops, 20 Intel i7 CPU kits, 60 USB-C docking kits under PKR 12 million.",
    "budget": Decimal("12000000"),
    "items": [
        {"name": "laptops", "quantity": 50},
        {"name": "CPU kit", "quantity": 20},
        {"name": "docking kit", "quantity": 60},
    ],
    "title": "Mixed hardware order — 3 line items",
}


def rule(title: str) -> None:
    print()
    print("=" * 74)
    print(title)
    print("=" * 74)


async def employee_id() -> UUID:
    from sqlalchemy import select

    from app.db.models import User

    async with session_scope() as session:
        uid = await session.scalar(
            select(User.id).where(User.email == "sara@agentflow.demo")
        )
    if uid is None:
        raise SystemExit("run scripts/seed_users.py first")
    return uid


async def create_workflow(spec: dict, requester: UUID) -> UUID:
    template = for_workflow_type(WorkflowType.PROCUREMENT)
    async with session_scope() as session:
        repo = WorkflowRepository(session)
        steps = StepRepository(session)
        wf = await repo.create(
            org_id=ORG,
            requester_id=requester,
            title=spec["title"],
            request_text=spec["text"],
            workflow_type=WorkflowType.PROCUREMENT.value,
            entities_json={
                "items": spec["items"],
                "budget": str(spec["budget"]),
                "currency": "PKR",
                "workflow_type": "procurement",
            },
            plan_json=template.plan_steps(),
            summary=spec["text"][:200],
            status=WorkflowStatus.DRAFT.value,
            currency="PKR",
            budget=spec["budget"],
            planner_attempts=0,
        )
        wf.checkpoint_thread_id = f"workflow:{wf.id}"
        await repo.add_items(wf, spec["items"])
        await steps.create_plan(
            wf.id, template.plan_steps(), max_retries=template.tool_max_attempts()
        )
        return wf.id


async def report(workflow_id: UUID) -> None:
    async with session_scope() as session:
        wf = await WorkflowRepository(session).get_or_raise(workflow_id)
        steps = await StepRepository(session).for_workflow(workflow_id)
        quotes = await QuoteRepository(session).for_workflow(workflow_id)
        po = await PurchaseOrderRepository(session).for_workflow(workflow_id)
        val = await ValidationRepository(session).latest(workflow_id)
        appr = await ApprovalRepository(session).open_for_workflow(workflow_id)

    rule(f"EXECUTION TRACE  ({wf.status})")
    for s in steps:
        mark = {"completed": "OK ", "failed": "ERR", "pending": " . ",
                "running": ">>>", "retrying": "RTY", "skipped": "---"}.get(s.status, "?")
        dur = f"{s.duration_ms}ms" if s.duration_ms else ""
        detail = (s.output_json or {}).get("summary") or s.error or ""
        print(f"  [{mark}] {s.step_order}. {s.title:<22} {dur:>8}  {detail}")

    if quotes:
        rule("QUOTE SNAPSHOTS (frozen at quote time)")
        for q in quotes:
            tot = f"PKR {q.total_amount:>12,.0f}" if q.total_amount else " " * 16
            score = f"{q.score_total:5.1f}" if q.score_total is not None else "  -  "
            print(f"  {q.vendor_name:<20}{tot}  cover {q.items_covered}/{q.items_requested}"
                  f"  score {score}  {q.status}")
            if q.exclusion_reason:
                print(f"      {q.exclusion_reason}")
            if q.confidence_percent is not None and q.confidence_percent < 100:
                print(f"      data confidence {q.confidence_percent}% "
                      f"(missing: {', '.join(q.missing_fields)})")

    if po:
        rule("PURCHASE ORDER")
        print(f"  {po.po_number}  ->  PKR {po.total_amount:,.2f}  ({po.currency})")
        print(f"  delivery {po.delivery_days}d · warranty {po.warranty_months}mo · "
              f"attempt {po.generation_attempt}")
        print(f"  priced from quote {po.quote_id} (snapshot, not live catalog)")
        print(f"  pdf: {po.pdf_path or 'rendered but Storage not configured'}")
        for li in po.line_items:
            print(f"    {li.line_number}. {li.description:<32} x{li.quantity:<4} "
                  f"@ {li.unit_price:>10,.0f} = {li.line_total:>12,.0f}")

    if val:
        rule(f"VALIDATION  (attempt {val.attempt}/{val.max_attempts})")
        for c in val.checks_json:
            flag = "PASS" if c["outcome"] == "passed" else c["outcome"].upper()
            print(f"  [{flag:<7}] {c['title']}")
            print(f"            {c['message']}")

    if appr:
        rule("HUMAN APPROVAL GATE")
        print(f"  approval {appr.id}")
        print(f"  decision : {appr.decision}   (agent CANNOT set this)")
        print(f"  workflow : {wf.status}")


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--multi", action="store_true")
    parser.add_argument("--over-budget", action="store_true")
    parser.add_argument("--approve", action="store_true", help="resume and approve")
    args = parser.parse_args()

    if not settings.database_configured:
        print("DATABASE_URL is not set."); return 2

    spec = dict(MULTI if args.multi else SINGLE)
    if args.over_budget:
        spec["budget"] = Decimal("1000000")
        spec["title"] = "Deliberately under-budget request"

    requester = await employee_id()
    workflow_id = await create_workflow(spec, requester)

    rule("REQUEST")
    print(f"  {spec['text']}")
    print(f"  budget PKR {spec['budget']:,.0f} · workflow {workflow_id}")

    from app.services import workflow_service

    result = await workflow_service.execute_workflow(workflow_id)
    await report(workflow_id)

    rule("RESULT")
    for k, v in result.items():
        print(f"  {k:<20} {v}")

    if args.approve and result.get("awaiting_approval"):
        rule("RESUMING AFTER HUMAN APPROVAL")
        async with session_scope() as session:
            appr = await ApprovalRepository(session).open_for_workflow(workflow_id)
            await ApprovalRepository(session).decide(
                appr, decision=ApprovalDecision.APPROVED, decided_by=requester,
                comment="Approved in demo run",
            )
        out = await workflow_service.resume_after_decision(
            workflow_id=workflow_id, decision=ApprovalDecision.APPROVED,
            comment="Approved in demo run",
        )
        print(f"  resumed -> {out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
