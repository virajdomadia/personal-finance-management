import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from app.prices.actions_parse import (
    ParsedAction,
    parse_bse_actions,
    parse_nse_actions,
    parse_purpose,
)

FIXTURES = Path(__file__).parent / "fixtures" / "prices"
D = Decimal


def load(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"), parse_float=Decimal)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share",
            [("split", D(10), D(1), None)],
        ),
        (
            "Face Value Split (Sub-Division) - From Rs 2/- Per Share To Re 1/- Per Share",
            [("split", D(2), D(1), None)],
        ),
        (
            "Consolidation Of Shares From Re 1/- Per Share To Rs 10/- Per Share",
            [("consolidation", D(1), D(10), None)],
        ),
        ("Bonus 1:1", [("bonus", D(1), D(1), None)]),
        ("Bonus 3:2", [("bonus", D(3), D(2), None)]),
        ("Interim Dividend - Rs 2.50 Per Share", [("dividend", None, None, D("2.50"))]),
        (
            "Final Dividend - Rs 10 Per Share / Special Dividend - Rs 5 Per Share",
            [("dividend", None, None, D(10)), ("dividend", None, None, D(5))],
        ),
        ("Dividend - Re 0.75 Per Share", [("dividend", None, None, D("0.75"))]),
        (
            "Dividend - Rs 5 Per Share / Bonus 1:1",
            [("dividend", None, None, D(5)), ("bonus", D(1), D(1), None)],
        ),
        ("Scheme Of Arrangement", [("demerger", None, None, None)]),
        ("Demerger", [("demerger", None, None, None)]),
        ("Amalgamation", [("merger", None, None, None)]),
        ("Annual General Meeting", []),
        ("Rights 1:5 @ Premium Rs 100/-", []),
        ("Buyback Of Shares At Rs 500", []),
        ("Buy Back Of Equity Shares", []),
        ("Open Offer At Rs 120 Per Share", []),
        ("Delisting Of Equity Shares", []),
        ("Dividend", [("other", None, None, None)]),
        ("Dividend - 150%", [("other", None, None, None)]),
        ("Interim Dividend - Rs - 2.5000 Per Share", [("dividend", None, None, D("2.5"))]),
        ("Bonus Issue 1 for 1", [("other", None, None, None)]),
        ("Scheme Of Merger", [("merger", None, None, None)]),
        ("Reduction Of Capital", [("other", None, None, None)]),
        ("", []),
        ("   ", []),
        # Segments joined by a bare "/", but never the "/-" after an amount.
        ("Annual General Meeting/Dividend - Rs 21 Per Share", [("dividend", None, None, D(21))]),
        ("AGM/DIVIDEND - RS 4 PER SHARE", [("dividend", None, None, D(4))]),
        (
            "Dividend - Rs 5 Per Share/Bonus 1:1",
            [("dividend", None, None, D(5)), ("bonus", D(1), D(1), None)],
        ),
        (
            "Face Value Split - From Rs 10/- Per Share To Re 1/- Per Share/Bonus 1:1",
            [("split", D(10), D(1), None), ("bonus", D(1), D(1), None)],
        ),
        # Thousands commas.
        ("Dividend - Rs 1,250 Per Share", [("dividend", None, None, D(1250))]),
        ("Special Dividend - Rs 1,250.50 Per Share", [("dividend", None, None, D("1250.50"))]),
        ("Dividend - Rs 1,25,000 Per Share", [("dividend", None, None, D(125000))]),
    ],
)
def test_parse_purpose(text, expected) -> None:
    assert parse_purpose(text) == expected


def test_nse_actions_fixture() -> None:
    """The fixture is a trimmed real NSE response (20 rows, Oct-Nov 2026)."""
    rows = parse_nse_actions(load("nse_actions.json"))
    by_kind: dict[str, list[ParsedAction]] = {}
    for row in rows:
        by_kind.setdefault(row.kind, []).append(row)
    assert {k: len(v) for k, v in by_kind.items()} == {"dividend": 13, "split": 3, "bonus": 2}
    assert (
        ParsedAction(
            "JSWDULUX",
            "INE133A01011",
            "split",
            date(2026, 10, 22),
            date(2026, 10, 22),
            D(10),
            D(1),
            None,
            "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share",
            "nse",
            "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share",
        )
        in rows
    )
    assert [(r.symbol, r.ratio_new, r.ratio_old) for r in by_kind["bonus"]] == [
        ("CONCORDBIO", D(1), D(1)),
        ("PASHUPATI", D(3), D(2)),
    ]
    assert next(r for r in rows if r.symbol == "ICICIAMC").amount_per_share == D(30)


def test_nse_non_list_payload_gives_nothing() -> None:
    assert parse_nse_actions({"error": "x"}) == []
    assert parse_nse_actions(None) == []


def test_bse_actions_map_isin_to_nse_symbol_and_drop_unmatched() -> None:
    mapping = {
        "INE002A01018": "RELIANCE",
        "INE467B01029": "TCS",
        "INE009A01021": "INFY",
    }
    rows = parse_bse_actions(load("bse_actions.json"), mapping)
    assert [(r.symbol, r.kind, r.ex_date, r.source) for r in rows] == [
        ("RELIANCE", "bonus", date(2026, 10, 28), "bse"),
        ("TCS", "dividend", date(2026, 3, 12), "bse"),
        ("INFY", "split", date(2026, 1, 5), "bse"),
    ]
    assert rows[0].record_date == date(2026, 10, 29)
    assert rows[1].amount_per_share == D("10.00") and rows[1].record_date is None
    assert (rows[2].ratio_new, rows[2].ratio_old) == (D(10), D(1))
    assert rows[0].purpose == "Bonus issue 1:1"


def test_bse_keys_are_case_insensitive_and_table_wrapper_ok() -> None:
    payload = {"Table": [{"ISIN_NUMBER": "INE1", "EX_DATE": "2026-03-12", "PURPOSE": "Bonus 1:1"}]}
    rows = parse_bse_actions(payload, {"INE1": "FOO"})
    assert [(r.symbol, r.ex_date) for r in rows] == [("FOO", date(2026, 3, 12))]
