"""po_generator -- render a purchase order to PDF and store it.

The PDF goes to Supabase Storage and is served through short-lived signed
URLs. Nothing is written to local disk: the API runs on ephemeral containers
where local files vanish on redeploy, and the Flutter client must be able to
fetch the document directly.

When Storage is unconfigured the tool still renders the PDF and reports the
bytes, so the workflow completes and the failure is visible in the trace
rather than fatal.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, NamedTuple

import structlog

from app.agent.tools.base import PermanentToolError, Tool, ToolContext
from app.core.config import settings

log = structlog.get_logger(__name__)


@dataclass(slots=True)
class POLine:
    description: str
    sku: str | None
    quantity: int
    unit_price: Decimal
    line_total: Decimal


@dataclass(slots=True)
class POGeneratorPayload:
    po_number: str
    vendor_name: str
    currency: str
    lines: list[POLine]
    subtotal: Decimal
    tax: Decimal
    total_amount: Decimal
    buyer_name: str = "AgentFlow Procurement"
    delivery_days: int | None = None
    expected_delivery_date: date | None = None
    warranty_months: int | None = None
    payment_terms: str | None = None
    delivery_address: str | None = None
    notes: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class POGeneratorResult:
    po_number: str
    object_path: str | None
    size_bytes: int
    uploaded: bool
    detail: str


# Vendor palette, matching the design.
_TURQUOISE = (0.267, 0.498, 0.596)   # #447F98
_SLATE = (0.384, 0.608, 0.710)       # #629BB5
_INK = (0.141, 0.212, 0.251)         # #243640
_MUTED = (0.373, 0.447, 0.502)       # #5F7280


class _Columns(NamedTuple):
    """Line-item column geometry, resolved once per document.

    A4 is 210 mm and the margins leave 170 mm. These offsets used to be magic
    numbers inline, sized for four-figure money: an order in the tens of
    millions overflowed its column and printed over the one to its left.

    Each column carries its own width so every field can be trimmed to what
    actually fits rather than to a guessed character count.
    """

    desc_x: float
    desc_w: float
    sku_x: float
    sku_w: float
    qty_right: float
    qty_w: float
    unit_right: float
    unit_w: float
    total_right: float
    total_w: float

    @classmethod
    def for_page(cls, left: float, right: float, mm: float) -> "_Columns":
        return cls(
            desc_x=left + 2 * mm,
            desc_w=66 * mm,
            sku_x=left + 70 * mm,
            sku_w=24 * mm,
            qty_right=left + 106 * mm,
            qty_w=12 * mm,
            unit_right=left + 134 * mm,
            unit_w=26 * mm,
            total_right=right - 2 * mm,
            total_w=32 * mm,
        )


def _fit(pdf, text: str, font: str, size: float, max_width: float) -> str:
    """Trim ``text`` to what actually fits in ``max_width``.

    Every overlap in this document came from guessing that N characters is
    about M millimetres. It is not: "Dell Latitude 5550 laptop" and
    "WWWWWWWWWWWWWWWWWWWWWWWWW" are the same length and nowhere near the same
    width. stringWidth measures the real thing.
    """
    text = (text or "").strip()
    if not text or pdf.stringWidth(text, font, size) <= max_width:
        return text

    ellipsis = "…"
    budget = max_width - pdf.stringWidth(ellipsis, font, size)
    if budget <= 0:
        return ""
    # Walk back from the end rather than binary-searching: these strings are
    # short, and the loop is obviously correct.
    trimmed = text
    while trimmed and pdf.stringWidth(trimmed, font, size) > budget:
        trimmed = trimmed[:-1]
    return trimmed.rstrip() + ellipsis


def render_po_pdf(payload: POGeneratorPayload) -> bytes:
    """Render the PO. Raises PermanentToolError if reportlab is unavailable."""
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.units import mm
        from reportlab.pdfgen import canvas
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise PermanentToolError(
            "reportlab is not installed; cannot render the purchase order PDF"
        ) from exc

    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4
    left, right = 20 * mm, width - 20 * mm
    cols = _Columns.for_page(left, right, mm)
    y = height - 22 * mm

    def money(value: Decimal) -> str:
        return f"{payload.currency} {value:,.2f}"

    # -- header ---------------------------------------------------------
    pdf.setFillColorRGB(*_TURQUOISE)
    pdf.rect(0, height - 16 * mm, width, 16 * mm, stroke=0, fill=1)
    pdf.setFillColorRGB(1, 1, 1)
    pdf.setFont("Helvetica-Bold", 15)
    pdf.drawString(left, height - 11 * mm, "PURCHASE ORDER")
    pdf.setFont("Helvetica", 10)
    pdf.drawRightString(right, height - 11 * mm, payload.po_number)

    y -= 6 * mm
    pdf.setFillColorRGB(*_INK)
    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(left, y, payload.buyer_name)
    pdf.drawRightString(right, y, payload.vendor_name)
    y -= 5 * mm
    pdf.setFont("Helvetica", 8.5)
    pdf.setFillColorRGB(*_MUTED)
    pdf.drawString(left, y, "Buyer")
    pdf.drawRightString(right, y, "Supplier")

    # -- terms ----------------------------------------------------------
    y -= 10 * mm
    terms: list[tuple[str, str]] = [
        ("Issued", datetime.now(UTC).strftime("%d %b %Y")),
    ]
    if payload.expected_delivery_date:
        terms.append(("Expected", payload.expected_delivery_date.strftime("%d %b %Y")))
    if payload.delivery_days is not None:
        terms.append(("Delivery", f"{payload.delivery_days} days"))
    if payload.warranty_months is not None:
        years = payload.warranty_months / 12
        terms.append(
            ("Warranty",
             f"{int(years)} year(s)" if years.is_integer()
             else f"{payload.warranty_months} months")
        )
    if payload.payment_terms:
        terms.append(("Payment", payload.payment_terms))

    # Columns sized from the page, not a fixed 35 mm stride. Payment terms
    # ("Net 30 days on delivery") are wider than 35 mm, so a fixed stride ran
    # one term's value straight into the next term's label.
    pdf.setFont("Helvetica", 9)
    span = (right - left) / max(len(terms), 1)
    for index, (label, value) in enumerate(terms):
        col = left + index * span
        pdf.setFillColorRGB(*_MUTED)
        pdf.drawString(col, y, _fit(pdf, label, "Helvetica", 9, span - 3 * mm))
        pdf.setFillColorRGB(*_INK)
        pdf.setFont("Helvetica-Bold", 9)
        pdf.drawString(
            col, y - 4.5 * mm, _fit(pdf, value, "Helvetica-Bold", 9, span - 3 * mm)
        )
        pdf.setFont("Helvetica", 9)

    # -- line items -----------------------------------------------------
    y -= 16 * mm
    pdf.setFillColorRGB(*_SLATE)
    pdf.rect(left, y - 2 * mm, right - left, 7 * mm, stroke=0, fill=1)
    pdf.setFillColorRGB(1, 1, 1)
    pdf.setFont("Helvetica-Bold", 8.5)
    pdf.drawString(cols.desc_x, y, "DESCRIPTION")
    pdf.drawString(cols.sku_x, y, "SKU")
    pdf.drawRightString(cols.qty_right, y, "QTY")
    pdf.drawRightString(cols.unit_right, y, "UNIT")
    pdf.drawRightString(cols.total_right, y, "TOTAL")

    y -= 9 * mm
    pdf.setFont("Helvetica", 9)
    for line in payload.lines:
        if y < 45 * mm:
            pdf.showPage()
            y = height - 25 * mm
            pdf.setFont("Helvetica", 9)
        pdf.setFillColorRGB(*_INK)
        # Every field trimmed to its own column's measured width.
        pdf.drawString(
            cols.desc_x,
            y,
            _fit(pdf, line.description, "Helvetica", 9, cols.desc_w),
        )
        pdf.setFillColorRGB(*_MUTED)
        pdf.drawString(
            cols.sku_x, y, _fit(pdf, line.sku or "-", "Helvetica", 9, cols.sku_w)
        )
        pdf.setFillColorRGB(*_INK)
        pdf.drawRightString(
            cols.qty_right,
            y,
            _fit(pdf, str(line.quantity), "Helvetica", 9, cols.qty_w),
        )
        pdf.drawRightString(
            cols.unit_right,
            y,
            _fit(pdf, f"{line.unit_price:,.2f}", "Helvetica", 9, cols.unit_w),
        )
        pdf.drawRightString(
            cols.total_right,
            y,
            _fit(pdf, f"{line.line_total:,.2f}", "Helvetica", 9, cols.total_w),
        )
        y -= 4 * mm
        pdf.setStrokeColorRGB(0.90, 0.93, 0.95)
        pdf.line(left, y, right, y)
        y -= 5 * mm

    # -- totals ---------------------------------------------------------
    y -= 3 * mm
    for label, value, bold in (
        ("Subtotal", payload.subtotal, False),
        ("Tax", payload.tax, False),
        ("Total", payload.total_amount, True),
    ):
        size = 11 if bold else 9
        font = "Helvetica-Bold" if bold else "Helvetica"
        pdf.setFont(font, size)
        text = money(value)
        # The label sat at a fixed offset that fell INSIDE the space a large
        # total needs, so "Subtotal" and "PKR 46,110,030.00" printed on top of
        # each other. Placed off the value's real width instead.
        label_right = cols.total_right - pdf.stringWidth(text, font, size) - 6 * mm
        pdf.setFillColorRGB(*(_TURQUOISE if bold else _MUTED))
        pdf.drawRightString(label_right, y, label)
        pdf.setFillColorRGB(*(_TURQUOISE if bold else _INK))
        pdf.drawRightString(cols.total_right, y, text)
        y -= 6 * mm

    if payload.delivery_address:
        y -= 4 * mm
        pdf.setFont("Helvetica", 8.5)
        pdf.setFillColorRGB(*_MUTED)
        pdf.drawString(left, y, "Deliver to")
        pdf.setFillColorRGB(*_INK)
        pdf.drawString(
            left,
            y - 4.5 * mm,
            _fit(pdf, payload.delivery_address, "Helvetica", 8.5, right - left),
        )

    # -- footer ---------------------------------------------------------
    pdf.setFont("Helvetica-Oblique", 7.5)
    pdf.setFillColorRGB(*_MUTED)
    pdf.drawString(
        left,
        14 * mm,
        "Generated by AgentFlow. Priced from the supplier quote snapshot taken "
        "at comparison time; subject to human approval before it commits spend.",
    )

    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


async def upload_to_storage(object_path: str, data: bytes) -> tuple[bool, str]:
    """Upload to Supabase Storage. Returns (uploaded, detail)."""
    if not settings.supabase_configured:
        return False, "Supabase Storage not configured; PDF rendered but not stored"

    try:
        from supabase import create_client
    except ImportError:  # pragma: no cover - dependency guard
        return False, "supabase client not installed"

    try:
        client = create_client(
            settings.supabase_url, settings.supabase_service_role_key
        )
        client.storage.from_(settings.supabase_storage_bucket).upload(
            path=object_path,
            file=data,
            file_options={"content-type": "application/pdf", "upsert": "true"},
        )
    except Exception as exc:  # noqa: BLE001 - reported, never fatal
        # Loudly. This failed silently for the entire life of the project
        # because the bucket did not exist, and the only symptom was a PDF
        # button that quietly never appeared.
        log.error(
            "po_generator.upload_failed",
            bucket=settings.supabase_storage_bucket,
            object_path=object_path,
            error=f"{type(exc).__name__}: {exc}",
            hint="does the bucket exist in Supabase Storage?",
        )
        return False, f"upload failed: {type(exc).__name__}: {exc}"
    return True, "uploaded"


class POGeneratorTool(Tool[POGeneratorPayload, POGeneratorResult]):
    name = "po_generator"
    description = (
        "Render a purchase order to PDF and store it in Supabase Storage, "
        "returning the object path for signed-URL access."
    )

    async def run(
        self, payload: POGeneratorPayload, ctx: ToolContext
    ) -> POGeneratorResult:
        data = render_po_pdf(payload)
        object_path = f"{ctx.workflow_id}/{payload.po_number}.pdf"
        uploaded, detail = await upload_to_storage(object_path, data)

        log.info(
            "po_generator.done",
            po_number=payload.po_number,
            bytes=len(data),
            uploaded=uploaded,
            workflow_id=str(ctx.workflow_id),
        )
        return POGeneratorResult(
            po_number=payload.po_number,
            object_path=object_path if uploaded else None,
            size_bytes=len(data),
            uploaded=uploaded,
            detail=detail,
        )
