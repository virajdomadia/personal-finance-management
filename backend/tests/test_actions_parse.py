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
        ("Buyback Of Shares At Rs 500", [("other", None, None, None)]),
        ("Dividend", []),
        ("", []),
        ("   ", []),
    ],
)
def test_parse_purpose(text, expected) -> None:
    assert parse_purpose(text) == expected


def test_nse_actions_fixture() -> None:
    rows = parse_nse_actions(load("nse_actions.json"))
    assert rows == [
        ParsedAction(
            "RELIANCE",
            "INE002A01018",
            "bonus",
            date(2026, 10, 28),
            date(2026, 10, 29),
            D(1),
            D(1),
            None,
            "Bonus 1:1",
            "nse",
        ),
        ParsedAction(
            "TCS",
            "INE467B01029",
            "dividend",
            date(2026, 3, 12),
            None,
            None,
            None,
            D(10),
            "Final Dividend - Rs 10 Per Share / Special Dividend - Rs 5 Per Share",
            "nse",
        ),
        ParsedAction(
            "TCS",
            "INE467B01029",
            "dividend",
            date(2026, 3, 12),
            None,
            None,
            None,
            D(5),
            "Final Dividend - Rs 10 Per Share / Special Dividend - Rs 5 Per Share",
            "nse",
        ),
        ParsedAction(
            "INFY",
            "INE009A01021",
            "split",
            date(2026, 1, 5),
            date(2026, 1, 6),
            D(10),
            D(1),
            None,
            "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share",
            "nse",
        ),
    ]


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
