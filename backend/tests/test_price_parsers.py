import json
from datetime import date
from decimal import Decimal
from pathlib import Path

from app.prices.parse import (
    Quote,
    parse_bhavcopy,
    parse_coin_search,
    parse_equity_list,
    parse_navall,
    parse_simple_price,
    parse_yahoo_close,
    to_price,
)

FIXTURES = Path(__file__).parent / "fixtures" / "prices"


def text(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def load_json(name: str) -> dict:
    return json.loads(text(name), parse_float=Decimal)


def test_navall_skips_headers_and_keeps_na_as_none() -> None:
    quotes = parse_navall(text("navall.txt"))
    assert [q.code for q in quotes] == ["119551", "119552", "120503", "120504"]
    assert quotes[2].price is None
    assert quotes[3].price is None
    assert quotes[1].isin == "INF209K01YM2"
    assert quotes[2].isin is None


def test_navall_parses_date_and_decimal() -> None:
    first = parse_navall(text("navall.txt"))[0]
    assert first == Quote(
        kind="mutual_fund",
        code="119551",
        name="Aditya Birla Sun Life Banking & PSU Debt Fund  - DIRECT - IDCW",
        isin="INF209KA12Z1",
        price=Decimal("101.2345"),
        price_date=date(2026, 11, 11),
    )


def test_equity_list_has_no_prices() -> None:
    quotes = parse_equity_list(text("equity_l.csv"))
    assert [q.code for q in quotes] == ["RELIANCE", "TCS", "INFY"]
    assert quotes[0].kind == "stock"
    assert quotes[0].name == "Reliance Industries Limited"
    assert quotes[0].isin == "INE002A01018"
    assert quotes[0].price is None and quotes[0].price_date is None


def test_bhavcopy_only_equity_series() -> None:
    assert parse_bhavcopy(text("bhavcopy.csv")) == {
        "RELIANCE": (Decimal("1312.45"), date(2026, 11, 11)),
        "TCS": (Decimal("4123.5"), date(2026, 11, 11)),
    }


def test_to_price_rounds_half_up() -> None:
    assert to_price("12.34565") == Decimal("12.3457")
    for bad in ("0", "-1", "NaN", "Infinity", "", "abc", "N.A."):
        assert to_price(bad) is None


def test_simple_price_reads_inr() -> None:
    assert parse_simple_price(load_json("simple_price.json")) == {
        "bitcoin": Decimal("9123456.78"),
        "ethereum": Decimal("312345.5"),
    }


def test_simple_price_skips_missing_inr() -> None:
    assert parse_simple_price({"bitcoin": {"inr": 5}, "x": {}, "y": {"inr": None}}) == {
        "bitcoin": Decimal("5")
    }


def test_coin_search_formats_name() -> None:
    quotes = parse_coin_search(load_json("search.json"))
    assert quotes[0] == Quote(
        kind="crypto",
        code="bitcoin",
        name="Bitcoin (BTC)",
        isin=None,
        price=None,
        price_date=None,
    )
    assert len(quotes) == 2


def test_coin_search_caps_at_twenty() -> None:
    coins = [{"id": f"c{i}", "name": "C", "symbol": "c"} for i in range(30)]
    assert len(parse_coin_search({"coins": coins})) == 20


def test_yahoo_close_takes_last_non_null() -> None:
    assert parse_yahoo_close(load_json("yahoo_chart.json")) == (
        Decimal("1312.45"),
        date(2026, 11, 10),
    )


def test_yahoo_close_none_when_no_data() -> None:
    assert parse_yahoo_close({"chart": {"result": None, "error": {"code": "Not Found"}}}) is None
