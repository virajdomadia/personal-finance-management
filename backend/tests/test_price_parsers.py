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


def test_to_price_rejects_out_of_range() -> None:
    assert to_price("1E+30") is None
    assert to_price("10000000000") is None
    assert to_price("9999999999.99995") is None
    assert to_price("9999999999.9999") == Decimal("9999999999.9999")


def test_navall_bad_date_or_non_positive_nav_gives_no_price() -> None:
    line = "1;INF000000001;-;Fund A;{nav};{date}"
    quotes = parse_navall(
        "\n".join(
            [
                line.format(nav="10.5", date="not-a-date"),
                line.format(nav="0", date="11-Nov-2026"),
                line.format(nav="-3", date="11-Nov-2026"),
            ]
        )
    )
    assert len(quotes) == 3
    assert all(q.price is None and q.price_date is None for q in quotes)


def test_navall_v2_reads_columns_by_header_and_survives_resent_header() -> None:
    quotes = parse_navall(text("navall_v2.txt"))
    assert [q.code for q in quotes] == ["135762", "135765", "135759", "135763", "135761"]
    assert quotes[0] == Quote(
        kind="mutual_fund",
        code="135762",
        name="Axis Children's Fund - Direct Plan - Growth Option",
        isin="INF846K01WO1",
        price=Decimal("31.0915"),
        price_date=date(2026, 11, 11),
    )
    assert quotes[1].isin == "INF846K01WP8"


def test_navall_data_line_with_wrong_field_count_is_skipped() -> None:
    header = "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;"
    header += "Option;Net Asset Value;Date"
    assert parse_navall(f"{header}\n1;INF000000001;-;Fund;10.5;11-Nov-2026\n") == []


def test_navall_unknown_header_yields_nothing() -> None:
    assert parse_navall("Scheme Code;Something Else\n1;2\n") == []


def test_navall_does_not_repeat_plan_text_already_in_the_name() -> None:
    header = "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;"
    header += "Option;Net Asset Value;Date"
    line = "1;INF000000001;-;Fund - Direct Plan - Growth;Direct Plan;Growth;10.5;11-Nov-2026"
    assert parse_navall(f"{header}\n{line}\n")[0].name == "Fund - Direct Plan - Growth"


def test_coindcx_ticker_keeps_inr_markets_with_real_prices() -> None:
    from app.prices.parse import parse_coindcx_ticker

    data = [
        {"market": "BTCINR", "last_price": "7426538.7000000000"},
        {"market": "ethinr", "last_price": "205500.1"},
        {"market": "BTCUSDT", "last_price": "73316.81"},
        {"market": "DOGEINR", "last_price": "0"},
        {"market": "XINR"},
        "not a row",
    ]
    assert parse_coindcx_ticker(data) == {
        "BTCINR": Decimal("7426538.7000"),
        "ETHINR": Decimal("205500.1000"),
    }


def test_bhavcopy_listings_carry_name_isin_and_close() -> None:
    from app.prices.parse import parse_bhavcopy_listings

    quotes = parse_bhavcopy_listings(text("bhavcopy.csv"))
    reliance = next(q for q in quotes if q.code == "RELIANCE")
    assert (reliance.kind, reliance.name, reliance.isin) == (
        "stock",
        "RELIANCE INDUSTRIES LTD",
        "INE002A01018",
    )
    assert reliance.price == Decimal("1312.4500")
    # Only the equity series, like the closes themselves.
    assert {q.code for q in quotes} == set(parse_bhavcopy(text("bhavcopy.csv")))
