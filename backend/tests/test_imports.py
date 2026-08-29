"""Spreadsheet import tests.

The cases are the ones a real vendor price list actually contains: a
semicolon-delimited export, headers nobody spells the way we do, money with a
currency prefix and thousands separators, a stray blank line, and rows that
are wrong in each of the distinct ways a row can be wrong.

The invariant these protect is that a bad row never costs a good one. Partial
import is the product decision; these tests are what keep it true.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from app.services import import_service as I


def _preview(content: bytes, *, filename: str = "prices.csv", existing=frozenset()):
    columns, rows = I.parse_file(filename, content)
    mapping = I.suggest_mapping(columns)
    return columns, mapping, I.validate_rows(
        rows, mapping, existing_skus=set(existing)
    )


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------
def test_sniffs_semicolon_delimiter():
    columns, _, verdicts = _preview(b"sku;title;price;stock\nA-1;Thing;10;2\n")
    assert columns == ["sku", "title", "price", "stock"]
    assert verdicts[0]["parsed"]["sku"] == "A-1"


def test_sniffs_tab_delimiter():
    columns, _, _ = _preview(b"sku\ttitle\tprice\tstock\nA-1\tThing\t10\t2\n")
    assert columns == ["sku", "title", "price", "stock"]


def test_strips_utf8_bom():
    columns, _, _ = _preview(b"\xef\xbb\xbfsku,title,price,stock\nA-1,T,10,2\n")
    assert columns[0] == "sku", "a BOM must not become part of the first header"


def test_reads_cp1252_when_not_utf8():
    # 0xA3 is a pound sign in cp1252 and invalid as standalone UTF-8.
    _, _, verdicts = _preview(b"sku,title,price,stock\nA-1,Caf\xa9,10,2\n")
    assert verdicts[0]["errors"] == []


def test_blank_lines_are_not_rows():
    _, _, verdicts = _preview(
        b"sku,title,price,stock\nA-1,Thing,10,2\n\n\n,,,\nB-2,Other,20,3\n"
    )
    assert len(verdicts) == 2


def test_duplicate_headers_are_disambiguated():
    columns, _, _ = _preview(b"sku,price,price,stock,title\nA,1,2,3,T\n")
    assert columns == ["sku", "price", "price (2)", "stock", "title"]


@pytest.mark.parametrize(
    ("content", "fragment"),
    [
        (b"", "empty"),
        (b"   \n  ", "empty"),
        (b"sku,title,price,stock\n", None),  # header only -> parses, zero rows
    ],
)
def test_unusable_files_are_rejected_with_a_reason(content, fragment):
    if fragment is None:
        _, rows = I.parse_file("a.csv", content)
        assert rows == []
        return
    with pytest.raises(I.ImportError_) as exc:
        I.parse_file("a.csv", content)
    assert fragment in str(exc.value).lower()


def test_oversized_file_is_rejected_before_parsing():
    from app.core.config import settings

    with pytest.raises(I.ImportError_) as exc:
        I.parse_file("a.csv", b"x" * (settings.import_max_file_bytes + 1))
    assert "larger than" in str(exc.value)


# --------------------------------------------------------------------------
# Column mapping
# --------------------------------------------------------------------------
def test_maps_headers_nobody_spells_our_way():
    _, mapping, _ = _preview(
        b"Item Code,Product Name,Unit Price,Qty,Lead Time,Warranty,Make\n"
        b"A-1,Thing,10,2,7,24,Acme\n"
    )
    got = {m["source_column"]: m["target_field"] for m in mapping}
    assert got == {
        "Item Code": "sku",
        "Product Name": "title",
        "Unit Price": "price",
        "Qty": "stock",
        "Lead Time": "delivery_days",
        "Warranty": "warranty_months",
        "Make": "brand",
    }


def test_a_target_is_claimed_once():
    """Two price-ish columns must not both map to price."""
    _, mapping, _ = _preview(b"sku,price,unit price,stock,title\nA,1,2,3,T\n")
    targets = [m["target_field"] for m in mapping]
    assert len(targets) == len(set(targets))


def test_exact_header_wins_over_alias():
    _, mapping, _ = _preview(b"code,sku,title,price,stock\nX,A-1,T,10,2\n")
    got = {m["source_column"]: m["target_field"] for m in mapping}
    assert got["sku"] == "sku", "the literal 'sku' column must win"


def test_unknown_columns_are_left_unmapped():
    columns, mapping, _ = _preview(
        b"sku,title,price,stock,internal_ref\nA-1,T,10,2,ZZ\n"
    )
    mapped = {m["source_column"] for m in mapping}
    assert "internal_ref" not in mapped
    assert set(columns) - mapped == {"internal_ref"}


# --------------------------------------------------------------------------
# Row validation -- each way a row can be wrong
# --------------------------------------------------------------------------
def _errors(verdict) -> dict[str, str]:
    return {e["field"]: e["message"] for e in verdict["errors"]}


def test_money_with_symbol_and_separators_parses():
    _, _, verdicts = _preview(
        b'sku,title,price,stock\nA-1,T,"PKR 174,000.50",2\n'
    )
    assert verdicts[0]["errors"] == []
    assert verdicts[0]["parsed"]["price"] == "174000.50"


def test_money_is_stored_as_string_not_float():
    """Money must survive JSONB without a binary-float round trip."""
    _, _, verdicts = _preview(b"sku,title,price,stock\nA-1,T,0.1,2\n")
    stored = verdicts[0]["parsed"]["price"]
    assert isinstance(stored, str)
    assert Decimal(stored) == Decimal("0.1")


def test_missing_required_cell_is_an_error():
    _, _, verdicts = _preview(b"sku,title,price,stock\nA-1,,10,2\n")
    assert "title" in _errors(verdicts[0])


def test_non_numeric_price_is_an_error():
    _, _, verdicts = _preview(b"sku,title,price,stock\nA-1,T,abc,2\n")
    assert "not a number" in _errors(verdicts[0])["price"]


def test_zero_and_negative_price_are_errors():
    _, _, verdicts = _preview(
        b"sku,title,price,stock\nA-1,T,0,2\nB-2,T,-5,2\n"
    )
    assert "greater than zero" in _errors(verdicts[0])["price"]
    assert "negative" in _errors(verdicts[1])["price"]


def test_fractional_stock_is_an_error():
    _, _, verdicts = _preview(b"sku,title,price,stock\nA-1,T,10,2.5\n")
    assert "whole number" in _errors(verdicts[0])["stock"]


def test_sale_price_above_price_is_an_error():
    _, _, verdicts = _preview(
        b"sku,title,price,stock,sale price\nA-1,T,100,2,500\n"
    )
    assert "higher than" in _errors(verdicts[0])["sale_price"]


def test_sku_repeated_inside_the_file_is_flagged():
    _, _, verdicts = _preview(
        b"sku,title,price,stock\nA-1,First,10,2\nA-1,Second,20,3\n"
    )
    assert verdicts[0]["errors"] == [], "the first occurrence is fine"
    assert "more than once" in _errors(verdicts[1])["sku"]


def test_sku_already_in_the_catalog_is_an_update_not_an_error():
    _, _, verdicts = _preview(
        b"sku,title,price,stock\nA-1,T,10,2\n", existing={"A-1"}
    )
    assert verdicts[0]["errors"] == []
    assert verdicts[0]["is_duplicate_sku"] is True


def test_unmapped_required_field_fails_every_row_with_one_message():
    _, _, verdicts = _preview(b"sku,title,stock\nA-1,T,2\nB-2,U,3\n")
    for verdict in verdicts:
        assert "price" in _errors(verdict)
        assert "No column is mapped" in _errors(verdict)["price"]


def test_absent_terms_are_reported_but_are_not_errors():
    """Missing delivery/warranty is a prompt, not a rejection."""
    _, _, verdicts = _preview(b"sku,title,price,stock\nA-1,T,10,2\n")
    assert verdicts[0]["errors"] == []
    assert verdicts[0]["missing_terms"] == ["delivery_days", "warranty_months"]


def test_one_bad_row_does_not_cost_the_good_ones():
    """The whole point of partial import."""
    _, _, verdicts = _preview(
        b"sku,title,price,stock\n"
        b"GOOD-1,Fine,10,2\n"
        b"BAD-1,,10,2\n"
        b"GOOD-2,Also fine,20,3\n"
    )
    valid = [v for v in verdicts if not v["errors"]]
    assert [v["parsed"]["sku"] for v in valid] == ["GOOD-1", "GOOD-2"]


def test_row_numbers_are_one_based_excluding_the_header():
    _, _, verdicts = _preview(
        b"sku,title,price,stock\nA-1,T,10,2\nB-2,U,20,3\n"
    )
    assert [v["row_number"] for v in verdicts] == [1, 2]


# --------------------------------------------------------------------------
# Handoff to the catalog adapter
# --------------------------------------------------------------------------
def test_valid_rows_become_source_items_with_exact_money():
    _, _, verdicts = _preview(
        b"sku,title,price,stock,lead time,warranty,make\n"
        b"A-1,Thing,174000.55,240,7,24,Acme\n"
    )
    item = I.to_source_items([verdicts[0]["parsed"]], currency="PKR")[0]
    assert item.sku == "A-1"
    assert item.price == Decimal("174000.55")
    assert item.stock == 240
    assert item.delivery_days == 7
    assert item.warranty_months == 24
    assert item.brand == "Acme"
    assert item.currency == "PKR"


# --------------------------------------------------------------------------
# Template
# --------------------------------------------------------------------------
def test_template_csv_header_matches_the_validator():
    header = I.template_csv().splitlines()[0].split(",")
    assert header == [f.name for f in I.TARGET_FIELDS]


def test_the_template_example_row_validates_clean():
    """The file we hand vendors must import without a single error."""
    _, _, verdicts = _preview(I.template_csv().encode())
    assert verdicts[0]["errors"] == []
    assert verdicts[0]["missing_terms"] == []


def test_required_fields_are_the_four_the_catalog_cannot_do_without():
    assert set(I.REQUIRED_FIELDS) == {"sku", "title", "price", "stock"}


# --------------------------------------------------------------------------
# Excel
# --------------------------------------------------------------------------
def test_xlsx_parses_the_same_as_csv():
    openpyxl = pytest.importorskip("openpyxl")
    import io as _io

    book = openpyxl.Workbook()
    sheet = book.active
    sheet.append(["sku", "title", "price", "stock"])
    sheet.append(["A-1", "Thing", 174000, 240])
    sheet.append([None, None, None, None])  # a blank row Excel loves to add
    buffer = _io.BytesIO()
    book.save(buffer)

    columns, mapping, verdicts = _preview(buffer.getvalue(), filename="p.xlsx")
    assert columns == ["sku", "title", "price", "stock"]
    assert len(verdicts) == 1, "the trailing blank row is not data"
    assert verdicts[0]["parsed"]["price"] == "174000"


def test_a_non_workbook_named_xlsx_is_rejected_clearly():
    with pytest.raises(I.ImportError_) as exc:
        I.parse_file("p.xlsx", b"this is not a zip archive")
    assert "readable" in str(exc.value)
