"""Purchase-order PDF layout.

These exist because the document shipped with overlapping text and nobody
noticed: the columns were magic offsets sized for four-figure money, and the
fields were trimmed by character count. "Dell Latitude 5550 laptop" and
"WWWWWWWWWWWWWWWWWWWWWWWWW" are the same length and nowhere near the same
width, so a long description printed over the SKU beside it, and an eight-
figure total printed over the word "Subtotal".

The check is per GLYPH, not per word. pdfplumber merges colliding glyphs into
a single word, so a word-level assertion passes on exactly the pages that are
broken -- which it did, on a page whose text read "PSKubRt o4t6a,l110,030.00".
"""
from __future__ import annotations

import io
from datetime import date
from decimal import Decimal

import pytest

from app.agent.tools.po_generator import POGeneratorPayload, POLine, render_po_pdf

pdfplumber = pytest.importorskip("pdfplumber")


def _payload(**overrides) -> POGeneratorPayload:
    base = dict(
        po_number="PO-2026-0021",
        vendor_name="TechSupplies Ltd",
        currency="PKR",
        lines=[
            POLine(
                description="Dell Latitude 5550 laptop",
                sku="TS-LAT-5550",
                quantity=50,
                unit_price=Decimal("174000.00"),
                line_total=Decimal("8700000.00"),
            )
        ],
        subtotal=Decimal("8700000.00"),
        tax=Decimal("0.00"),
        total_amount=Decimal("8700000.00"),
        buyer_name="Vertex Group",
        delivery_days=7,
        expected_delivery_date=date(2026, 9, 5),
        warranty_months=24,
        payment_terms="Net 30",
        delivery_address="Vertex Group HQ, Islamabad",
        notes=None,
        metadata={},
    )
    base.update(overrides)
    return POGeneratorPayload(**base)


def _collisions(data: bytes) -> list[str]:
    """Every pair of glyphs that share a baseline and intersect."""

    def hits(a, b) -> bool:
        pad = 0.4  # kerning tolerance
        return not (
            a["x1"] - pad <= b["x0"]
            or b["x1"] - pad <= a["x0"]
            or a["bottom"] - pad <= b["top"]
            or b["bottom"] - pad <= a["top"]
        )

    found: list[str] = []
    with pdfplumber.open(io.BytesIO(data)) as doc:
        for pageno, page in enumerate(doc.pages, start=1):
            rows: dict[float, list] = {}
            for c in page.chars:
                if (c["text"] or "").strip():
                    rows.setdefault(round(c["top"], 0), []).append(c)
            for top, row in rows.items():
                row.sort(key=lambda c: c["x0"])
                for i in range(len(row) - 1):
                    if hits(row[i], row[i + 1]):
                        found.append(
                            f"p{pageno} y={top:.0f}: "
                            f"{row[i]['text']!r} x {row[i + 1]['text']!r}"
                        )
    return found


def _text(data: bytes) -> str:
    with pdfplumber.open(io.BytesIO(data)) as doc:
        return "\n".join(p.extract_text() or "" for p in doc.pages)


# --------------------------------------------------------------------------
# Nothing may overlap
# --------------------------------------------------------------------------
def test_the_demo_order_has_no_overlapping_glyphs():
    assert _collisions(render_po_pdf(_payload())) == []


def test_eight_figure_money_does_not_print_over_its_label():
    """The total column has to hold the number, not the number the label."""
    data = render_po_pdf(
        _payload(
            lines=[
                POLine(
                    description="Dell Latitude 5550 laptop",
                    sku="TS-LAT-5550",
                    quantity=250,
                    unit_price=Decimal("174000.00"),
                    line_total=Decimal("43500000.00"),
                )
            ],
            subtotal=Decimal("43500000.00"),
            total_amount=Decimal("43500000.00"),
        )
    )
    assert _collisions(data) == []
    text = _text(data)
    assert "Subtotal" in text
    assert "43,500,000.00" in text


def test_a_long_description_does_not_run_into_the_sku():
    data = render_po_pdf(
        _payload(
            lines=[
                POLine(
                    description="Dell Latitude 5550 business laptop, i7-1355U, "
                    "16GB RAM, 512GB NVMe SSD, 3-year on-site warranty",
                    sku="TS-LAT-5550-I7-16-512-XL",
                    quantity=50,
                    unit_price=Decimal("174000.00"),
                    line_total=Decimal("8700000.00"),
                )
            ]
        )
    )
    assert _collisions(data) == []


def test_verbose_payment_terms_do_not_run_into_the_next_term():
    """The terms row used a fixed 35 mm stride regardless of content."""
    data = render_po_pdf(
        _payload(payment_terms="Net 30 days from delivery and inspection")
    )
    assert _collisions(data) == []


def test_absurd_values_still_lay_out():
    """Not realistic; it is the shape that breaks fixed-width assumptions."""
    data = render_po_pdf(
        _payload(
            vendor_name="A",
            buyer_name="B",
            lines=[
                POLine(
                    description="X" * 200,
                    sku="Y" * 60,
                    quantity=999999,
                    unit_price=Decimal("9876543210.99"),
                    line_total=Decimal("9876543210987.65"),
                )
            ],
            subtotal=Decimal("9876543210987.65"),
            tax=Decimal("1234567.89"),
            total_amount=Decimal("9876544445555.54"),
            delivery_days=None,
            expected_delivery_date=None,
            warranty_months=None,
            payment_terms=None,
            delivery_address=None,
        )
    )
    assert _collisions(data) == []


def test_many_lines_paginate_without_overlap():
    lines = [
        POLine(
            description=f"Line item number {i} with a reasonably long name",
            sku=f"SKU-{i:04d}",
            quantity=i + 1,
            unit_price=Decimal("12345.67"),
            line_total=Decimal("12345.67") * (i + 1),
        )
        for i in range(40)
    ]
    data = render_po_pdf(
        _payload(
            lines=lines,
            subtotal=Decimal("10131050.47"),
            total_amount=Decimal("10131050.47"),
        )
    )
    assert _collisions(data) == []
    with pdfplumber.open(io.BytesIO(data)) as doc:
        assert len(doc.pages) > 1, "40 lines should not fit on one page"


# --------------------------------------------------------------------------
# The content has to survive the trimming
# --------------------------------------------------------------------------
def test_the_commercial_facts_are_all_present():
    text = _text(render_po_pdf(_payload()))
    for expected in (
        "PURCHASE ORDER",
        "PO-2026-0021",
        "TechSupplies Ltd",
        "Vertex Group",
        "Dell Latitude 5550 laptop",
        "TS-LAT-5550",
        "174,000.00",
        "8,700,000.00",
        "Total",
    ):
        assert expected in text, f"{expected!r} missing from the document"


def test_the_snapshot_disclaimer_is_on_every_purchase_order():
    """The PO is priced from a frozen quote; the document has to say so."""
    text = _text(render_po_pdf(_payload()))
    assert "quote snapshot" in text
    assert "human approval" in text


def test_trimming_marks_itself_rather_than_silently_cutting():
    text = _text(
        render_po_pdf(
            _payload(
                lines=[
                    POLine(
                        description="A description far too long to fit inside "
                        "the description column of an A4 purchase order",
                        sku="SKU-1",
                        quantity=1,
                        unit_price=Decimal("1.00"),
                        line_total=Decimal("1.00"),
                    )
                ]
            )
        )
    )
    assert "…" in text, "a truncated field should end in an ellipsis"
