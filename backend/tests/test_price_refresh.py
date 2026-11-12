import logging
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.api.portfolio import latest_prices
from app.main import app
from app.models.investment import Instrument, InstrumentPrice
from app.models.market import MarketCode
from app.models.user import User
from app.prices.fetch import SourceTimeout
from app.prices.refresh import RefreshReport, apply_to_users, refresh_market, run_nightly
from tests.price_fakes import (
    COIN_ID,
    COIN_PRICE,
    FUND_CODE,
    FUND_DATE,
    FUND_NAV,
    STOCK_CLOSE,
    STOCK_CODE,
    STOCK_DATE,
    FakeFetcher,
    read,
)
from tests.test_accounts import Headers, auth
from tests.test_fund_trades import bank, buy, fund
from tests.test_stocks import add_price, add_stock

client = TestClient(app)
TODAY = date(2026, 11, 12)


def user(db: Session, email: str) -> int:
    row = User(email=email)
    db.add(row)
    db.commit()
    return row.id


def link(db: Session, user_id: int, kind: str, code: str | None, symbol: str = "X") -> Instrument:
    inst = Instrument(user_id=user_id, kind=kind, symbol=symbol, name=symbol, source_code=code)
    db.add(inst)
    db.commit()
    return inst


def rows(db: Session, inst: Instrument) -> list[InstrumentPrice]:
    return list(
        db.scalars(
            select(InstrumentPrice)
            .where(InstrumentPrice.instrument_id == inst.id)
            .order_by(InstrumentPrice.id)
        )
    )


def market(db: Session, kind: str, code: str) -> MarketCode:
    row = db.scalar(select(MarketCode).where(MarketCode.kind == kind, MarketCode.code == code))
    assert row is not None
    return row


def test_funds_and_stocks_and_crypto_update_linked_instruments(db_session: Session) -> None:
    a, b = user(db_session, "a@example.com"), user(db_session, "b@example.com")
    f = link(db_session, a, "mutual_fund", FUND_CODE, "FUND")
    s = link(db_session, a, "stock", STOCK_CODE, "RELIANCE")
    c = link(db_session, b, "crypto", COIN_ID, "BTC")

    report = run_nightly(db_session, FakeFetcher(), TODAY)

    assert report.failed == {}
    assert report.updated["mutual_fund"] >= 1
    for inst, price, day in [
        (f, FUND_NAV, FUND_DATE),
        (s, STOCK_CLOSE, STOCK_DATE),
        (c, COIN_PRICE, TODAY),
    ]:
        [row] = rows(db_session, inst)
        assert (row.source, row.price, row.date) == ("auto", price, day)


def test_unlinked_instruments_untouched(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    unlinked = link(db_session, a, "mutual_fund", None, "FUND")
    run_nightly(db_session, FakeFetcher(), TODAY)
    assert rows(db_session, unlinked) == []


def test_refresh_does_not_fetch_prices_for_unlinked_holdings(db_session: Session) -> None:
    fetcher = FakeFetcher(holiday=True)
    refresh_market(db_session, fetcher, TODAY)
    assert fetcher.calls["simple_price"] == 0
    assert fetcher.calls["yahoo_chart"] == 0


def test_kinds_limits_what_is_refreshed(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    link(db_session, a, "crypto", COIN_ID)
    fetcher = FakeFetcher()
    report = refresh_market(db_session, fetcher, TODAY, {"crypto"})
    assert set(report.updated) == {"crypto"}
    assert fetcher.calls["navall"] == 0 and fetcher.calls["equity_list"] == 0


def test_manual_price_same_day_is_kept(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    f = link(db_session, a, "mutual_fund", FUND_CODE)
    db_session.add(
        InstrumentPrice(
            user_id=a, instrument_id=f.id, date=FUND_DATE, price=Decimal("99"), source="manual"
        )
    )
    db_session.commit()

    run_nightly(db_session, FakeFetcher(), TODAY)
    run_nightly(db_session, FakeFetcher(), TODAY)

    [row] = rows(db_session, f)
    assert (row.source, row.price) == ("manual", Decimal("99.0000"))


def test_manual_typed_after_auto_wins(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    headers = auth(db_session, monkeypatch)
    stock_id = add_stock(headers, STOCK_CODE).json()["id"]
    inst = db_session.get(Instrument, stock_id)
    assert inst is not None
    inst.source_code = STOCK_CODE
    db_session.commit()
    user_id = inst.user_id

    run_nightly(db_session, FakeFetcher(), TODAY)
    assert add_price(headers, stock_id, STOCK_DATE.isoformat(), "1500").status_code == 201
    assert latest_prices(db_session, user_id)[stock_id] == (STOCK_DATE, Decimal("1500"))

    run_nightly(db_session, FakeFetcher(), TODAY)

    assert latest_prices(db_session, user_id)[stock_id] == (STOCK_DATE, Decimal("1500"))
    assert [(r.source, r.price) for r in rows(db_session, inst)] == [
        ("auto", STOCK_CLOSE),
        ("manual", Decimal("1500.0000")),
    ]


def test_fund_trade_nav_counts_as_existing(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers: Headers = auth(db_session, monkeypatch)
    fund_id = fund(headers)
    account_id = bank(headers)
    response = buy(
        headers, fund_id=fund_id, account_id=account_id, date="2026-11-11", nav="84.3793"
    )
    assert response.status_code == 201, response.json()
    inst = db_session.get(Instrument, fund_id)
    assert inst is not None
    inst.source_code = FUND_CODE
    db_session.commit()
    before = [(r.id, r.price, r.trade_id) for r in rows(db_session, inst)]
    assert len(before) == 1 and before[0][2] is not None

    run_nightly(db_session, FakeFetcher(), TODAY)

    assert [(r.id, r.price, r.trade_id) for r in rows(db_session, inst)] == before


def test_holiday_bhavcopy_none_falls_back_to_yahoo(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    s = link(db_session, a, "stock", STOCK_CODE)
    f = link(db_session, a, "mutual_fund", FUND_CODE)
    c = link(db_session, a, "crypto", COIN_ID)
    fetcher = FakeFetcher(holiday=True)

    report = run_nightly(db_session, fetcher, TODAY)

    assert report.failed == {}
    assert fetcher.calls["yahoo_chart"] == 1  # only the linked stock
    [row] = rows(db_session, s)
    assert row.source == "auto" and row.price == Decimal("1312.45")
    assert [r.price for r in rows(db_session, f)] == [FUND_NAV]
    assert [r.price for r in rows(db_session, c)] == [COIN_PRICE]


def test_unreadable_bhavcopy_falls_back_to_yahoo(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    s = link(db_session, a, "stock", STOCK_CODE)
    fetcher = FakeFetcher(texts={"bhavcopy.csv": "Some,New,Format\n1,2,3\n"})
    report = run_nightly(db_session, fetcher, TODAY)
    assert report.failed == {}
    assert fetcher.calls["yahoo_chart"] == 1
    assert [r.price for r in rows(db_session, s)] == [STOCK_CLOSE]


def test_overlong_name_is_clipped_and_overlong_code_skipped(db_session: Session) -> None:
    text = read("navall.txt")
    long_name = "Z" * 200
    long_line = f"{'9' * 41};-;-;{long_name};10.5;11-Nov-2026"
    clipped_line = f"777777;-;-;{long_name};10.5;11-Nov-2026"
    fetcher = FakeFetcher(texts={"navall.txt": text + long_line + "\n" + clipped_line + "\n"})
    report = refresh_market(db_session, fetcher, TODAY, {"mutual_fund"})
    assert report.failed == {}
    assert market(db_session, "mutual_fund", "777777").name == "Z" * 160
    assert db_session.scalar(select(MarketCode).where(MarketCode.code == "9" * 41)) is None


def test_unexpected_error_in_one_source_does_not_block_others(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    f = link(db_session, a, "mutual_fund", FUND_CODE)
    s = link(db_session, a, "stock", STOCK_CODE)
    c = link(db_session, a, "crypto", COIN_ID)

    report = run_nightly(db_session, FakeFetcher(crash={"navall"}), TODAY)

    assert list(report.failed) == ["mutual_fund"]
    assert "RuntimeError" in report.failed["mutual_fund"]
    assert rows(db_session, f) == []
    assert len(rows(db_session, s)) == 1 and len(rows(db_session, c)) == 1


def test_bhavcopy_error_falls_back_to_yahoo(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    s = link(db_session, a, "stock", STOCK_CODE)
    report = run_nightly(db_session, FakeFetcher(fail={"bhavcopy"}), TODAY)
    assert report.failed == {}
    assert len(rows(db_session, s)) == 1


def test_one_source_failing_does_not_block_others(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    f = link(db_session, a, "mutual_fund", FUND_CODE)
    s = link(db_session, a, "stock", STOCK_CODE)
    c = link(db_session, a, "crypto", COIN_ID)
    run_nightly(db_session, FakeFetcher(), date(2026, 11, 11))
    fund_before = [(r.id, r.price) for r in rows(db_session, f)]
    stale = market(db_session, "mutual_fund", FUND_CODE).price
    market(db_session, "crypto", COIN_ID).price = Decimal("1")
    db_session.commit()

    report = run_nightly(db_session, FakeFetcher(fail={"navall"}), TODAY)

    assert report.failed == {"mutual_fund": "navall is down"}
    assert [(r.id, r.price) for r in rows(db_session, f)] == fund_before
    assert market(db_session, "mutual_fund", FUND_CODE).price == stale
    assert report.updated["stock"] >= 1 and report.updated["crypto"] == 1
    assert len(rows(db_session, s)) == 1
    assert market(db_session, "crypto", COIN_ID).price == COIN_PRICE
    assert len(rows(db_session, c)) == 2  # yesterday's and today's


def test_na_nav_does_not_clear_previous_market_price(db_session: Session) -> None:
    db_session.add(
        MarketCode(
            kind="mutual_fund",
            code="120503",
            name="Axis Bluechip Fund - Direct Plan - IDCW",
            price=Decimal("55.5000"),
            price_date=date(2026, 11, 10),
        )
    )
    db_session.commit()

    refresh_market(db_session, FakeFetcher(), TODAY)

    row = market(db_session, "mutual_fund", "120503")
    assert (row.price, row.price_date) == (Decimal("55.5000"), date(2026, 11, 10))


def test_market_codes_are_upserted_without_duplicates(db_session: Session) -> None:
    refresh_market(db_session, FakeFetcher(), TODAY)
    first = market(db_session, "mutual_fund", FUND_CODE).id
    refresh_market(db_session, FakeFetcher(), TODAY)
    codes = list(
        db_session.scalars(select(MarketCode.code).where(MarketCode.kind == "mutual_fund"))
    )
    assert len(codes) == len(set(codes)) == 4
    assert market(db_session, "mutual_fund", FUND_CODE).id == first


def test_crypto_auto_row_updated_in_place_same_day(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    c = link(db_session, a, "crypto", COIN_ID)
    run_nightly(db_session, FakeFetcher(), TODAY)
    [first] = rows(db_session, c)

    market(db_session, "crypto", COIN_ID).price = Decimal("9200000")
    db_session.commit()
    assert apply_to_users(db_session) == 1
    db_session.commit()

    [row] = rows(db_session, c)
    assert row.id == first.id and row.price == Decimal("9200000.0000")
    assert apply_to_users(db_session) == 0


def test_apply_to_users_only_kind(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    f = link(db_session, a, "mutual_fund", FUND_CODE)
    c = link(db_session, a, "crypto", COIN_ID)
    refresh_market(db_session, FakeFetcher(), TODAY)
    assert apply_to_users(db_session, only_kind="crypto") == 1
    assert rows(db_session, f) == [] and len(rows(db_session, c)) == 1


def test_report_shape() -> None:
    assert RefreshReport(updated={}, failed={}).failed == {}


def test_unreadable_navall_fails_the_fund_source_loudly(db_session: Session) -> None:
    fetcher = FakeFetcher(texts={"navall.txt": "Scheme Code;Brand New Layout\n1;2\n"})

    report = run_nightly(db_session, fetcher, TODAY)

    assert report.failed == {"mutual_fund": "AMFI file format not recognised"}
    assert report.updated["stock"] == 2  # the two fixture listings that have a bhavcopy close


def test_unreadable_equity_list_is_a_stock_error_when_nothing_is_priced(
    db_session: Session,
) -> None:
    fetcher = FakeFetcher(texts={"equity_l.csv": "NOT,THE,RIGHT\n1,2,3\n"}, holiday=True)

    report = run_nightly(db_session, fetcher, TODAY)

    assert report.failed == {
        "stock": "NSE equity list format not recognised; "
        "no NSE price file found for the last 4 weekdays"
    }


def test_missing_bhavcopy_today_uses_the_previous_trading_day(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    s = link(db_session, a, "stock", STOCK_CODE)
    asked: list[date] = []

    class Late(FakeFetcher):
        def bhavcopy(self, day: date) -> str | None:
            asked.append(day)
            return None if day >= date(2026, 11, 11) else super().bhavcopy(day)

    fetcher = Late()
    run_nightly(db_session, fetcher, TODAY)

    assert asked == [date(2026, 11, 12), date(2026, 11, 11), date(2026, 11, 10)]
    assert fetcher.calls["yahoo_chart"] == 0
    assert [r.price for r in rows(db_session, s)] == [STOCK_CLOSE]


def test_bhavcopy_lookback_skips_weekends_and_gives_up(db_session: Session) -> None:
    asked: list[date] = []

    class Never(FakeFetcher):
        def bhavcopy(self, day: date) -> str | None:
            asked.append(day)
            return None

    run_nightly(db_session, Never(), date(2026, 11, 16))  # a Monday

    assert asked == [date(2026, 11, 16), date(2026, 11, 13), date(2026, 11, 12), date(2026, 11, 11)]


def test_unreadable_equity_list_is_reported_even_when_prices_still_apply(
    db_session: Session, caplog: pytest.LogCaptureFixture
) -> None:
    db_session.add(MarketCode(kind="stock", code=STOCK_CODE, name="Reliance"))
    db_session.commit()
    fetcher = FakeFetcher(texts={"equity_l.csv": "NOT,THE,RIGHT\n1,2,3\n"})

    logging.getLogger("app.prices").disabled = False  # alembic's logging setup can disable it
    with caplog.at_level("WARNING", logger="app.prices"):
        report = run_nightly(db_session, fetcher, TODAY)

    # Reliance, plus TCS: the price file lists it even though the equity list couldn't be read.
    assert report.updated["stock"] == 2
    assert report.failed == {"stock": "NSE equity list format not recognised"}
    assert market(db_session, "stock", STOCK_CODE).price == STOCK_CLOSE
    assert "NSE equity list format not recognised" in caplog.text


def test_bhavcopy_source_error_is_logged_before_falling_back(
    db_session: Session, caplog: pytest.LogCaptureFixture
) -> None:
    logging.getLogger("app.prices").disabled = False  # alembic's logging setup can disable it
    with caplog.at_level("WARNING", logger="app.prices"):
        run_nightly(db_session, FakeFetcher(fail={"bhavcopy"}), TODAY)

    assert "bhavcopy for 2026-11-12 unavailable" in caplog.text


class Killed(BaseException):
    """What the platform does to a function past its time limit: nothing catches it."""


def test_finished_kinds_are_committed_when_stocks_are_killed(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    f = link(db_session, a, "mutual_fund", FUND_CODE)
    s = link(db_session, a, "stock", STOCK_CODE)
    c = link(db_session, a, "crypto", COIN_ID)

    class Hangs(FakeFetcher):
        def equity_list(self) -> str:
            raise Killed

    with pytest.raises(Killed):
        run_nightly(db_session, Hangs(), TODAY)
    db_session.rollback()  # whatever was not committed is gone now

    assert [r.price for r in rows(db_session, f)] == [FUND_NAV]
    assert [r.price for r in rows(db_session, c)] == [COIN_PRICE]
    assert market(db_session, "crypto", COIN_ID).price == COIN_PRICE
    assert rows(db_session, s) == []


def test_bhavcopy_lookback_stops_after_a_timeout(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    s = link(db_session, a, "stock", STOCK_CODE)

    class Slow(FakeFetcher):
        def bhavcopy(self, day: date) -> str | None:
            self._hit("bhavcopy")
            raise SourceTimeout("request timed out: ReadTimeout")

    fetcher = Slow()
    report = run_nightly(db_session, fetcher, TODAY)

    assert fetcher.calls["bhavcopy"] == 1
    assert fetcher.calls["yahoo_chart"] == 1
    assert [r.price for r in rows(db_session, s)] == [STOCK_CLOSE]
    assert report.failed == {
        "stock": "NSE timed out on the 2026-11-12 price file; stopped looking further back"
    }


def test_yahoo_fallback_stops_when_the_time_budget_is_spent(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    s = link(db_session, a, "stock", STOCK_CODE, "RELIANCE")
    t1 = link(db_session, a, "stock", "TCS", "TCS")
    t2 = link(db_session, a, "stock", "ZZZ", "ZZZ")
    ticks = iter([0.0, 30.0, 60.0, 90.0])  # each read of the clock is 30 s later

    fetcher = FakeFetcher(holiday=True)
    report = run_nightly(db_session, fetcher, TODAY, clock=lambda: next(ticks))

    assert fetcher.calls["yahoo_chart"] == 1  # RELIANCE at 30 s; at 60 s the 45 s budget is gone
    assert [r.price for r in rows(db_session, s)] == [STOCK_CLOSE]
    assert rows(db_session, t1) == [] and rows(db_session, t2) == []
    assert report.updated["stock"] == 1
    assert report.failed == {"stock": "time ran out; skipped Yahoo for 2 stock(s): TCS, ZZZ"}


def test_no_price_file_and_no_yahoo_price_is_reported(
    db_session: Session, caplog: pytest.LogCaptureFixture
) -> None:
    logging.getLogger("app.prices").disabled = False  # alembic's logging setup can disable it
    with caplog.at_level("WARNING", logger="app.prices"):
        report = run_nightly(db_session, FakeFetcher(holiday=True), TODAY)

    assert report.failed == {"stock": "no NSE price file found for the last 4 weekdays"}
    assert "no NSE price file found for the last 4 weekdays" in caplog.text


def test_unchanged_price_still_marks_the_code_fresh(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    link(db_session, a, "crypto", COIN_ID)
    refresh_market(db_session, FakeFetcher(), TODAY, {"crypto"})
    db_session.commit()
    old = datetime(2000, 1, 1, tzinfo=UTC)
    db_session.execute(update(MarketCode).where(MarketCode.code == COIN_ID).values(updated_at=old))
    db_session.commit()

    refresh_market(db_session, FakeFetcher(), TODAY, {"crypto"})  # same price as before
    db_session.commit()

    stamp = db_session.scalar(select(MarketCode.updated_at).where(MarketCode.code == COIN_ID))
    assert stamp is not None and stamp.year > 2000


def test_apply_to_users_can_be_limited_to_one_user(db_session: Session) -> None:
    a, b = user(db_session, "a@example.com"), user(db_session, "b@example.com")
    mine = link(db_session, a, "mutual_fund", FUND_CODE)
    theirs = link(db_session, b, "mutual_fund", FUND_CODE)
    refresh_market(db_session, FakeFetcher(), TODAY, {"mutual_fund"})

    assert apply_to_users(db_session, only_kind="mutual_fund", user_id=a) == 1
    assert len(rows(db_session, mine)) == 1 and rows(db_session, theirs) == []


NOV_11 = date(2026, 11, 11)


def test_market_codes_are_written_in_a_few_statements(db_session: Session) -> None:
    """Thousands of codes must not mean thousands of round trips: the production API and its
    database sit in different regions, and one statement per row ran past the time limit."""
    from sqlalchemy import event

    from app.prices.parse import Quote
    from app.prices.refresh import UPSERT_CHUNK, _upsert_quotes

    quotes = [
        Quote(
            "mutual_fund", str(100000 + i), f"Fund {i}", None, Decimal("10.5"), date(2026, 11, 11)
        )
        for i in range(1200)
    ]
    writes: list[str] = []

    def count(conn, cursor, statement, *args) -> None:  # noqa: ANN001
        if statement.lstrip().upper().startswith(("INSERT", "UPDATE")):
            writes.append(statement)

    engine = db_session.get_bind()
    event.listen(engine, "before_cursor_execute", count)
    try:
        assert _upsert_quotes(db_session, "mutual_fund", quotes) == 1200
        # Same quotes again: nothing changed, so nothing is written.
        assert _upsert_quotes(db_session, "mutual_fund", quotes) == 1200
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert len(writes) == -(-1200 // UPSERT_CHUNK)  # ceil: 3 chunks, then none
    stored = db_session.scalar(
        select(func.count()).select_from(MarketCode).where(MarketCode.kind == "mutual_fund")
    )
    assert stored == 1200


DCX = [
    {"market": "BTCINR", "last_price": "7426538.7000000000"},
    {"market": "BTCUSDT", "last_price": "73316.81"},
    {"market": "SOLINR", "last_price": "0"},  # not a real price: ignored
]


def test_crypto_uses_coindcx_inr_price_where_it_lists_the_coin(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    btc = link(db_session, a, "crypto", COIN_ID, symbol="BTC")
    eth = link(db_session, a, "crypto", "ethereum", symbol="ETH")  # no ETHINR row in DCX
    fetcher = FakeFetcher(coindcx=DCX)

    report = run_nightly(db_session, fetcher, TODAY)

    assert report.failed == {}
    # Rounded to the 4 places a price is stored with.
    assert [r.price for r in rows(db_session, btc)] == [Decimal("7426538.7000")]
    # Not on CoinDCX: CoinGecko's global price, asked for that coin only.
    assert [r.price for r in rows(db_session, eth)] == [Decimal("312345.5000")]
    assert fetcher.calls["simple_price"] == 1


def test_crypto_falls_back_to_coingecko_when_coindcx_is_down(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    btc = link(db_session, a, "crypto", COIN_ID, symbol="BTC")
    fetcher = FakeFetcher(coindcx=DCX, fail={"coindcx_ticker"})

    report = run_nightly(db_session, fetcher, TODAY)

    assert report.failed == {}
    assert [r.price for r in rows(db_session, btc)] == [COIN_PRICE]


def test_crypto_on_coindcx_does_not_ask_coingecko(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    link(db_session, a, "crypto", COIN_ID, symbol="btc")  # ticker case doesn't matter
    fetcher = FakeFetcher(coindcx=DCX)

    run_nightly(db_session, fetcher, TODAY)

    assert fetcher.calls["simple_price"] == 0
    assert market(db_session, "crypto", COIN_ID).price == Decimal("7426538.7000")


ETF_ROW = (
    "2026-11-11,2026-11-11,CM,NSE,STK,10176,INF204KB14I2,NIFTYBEES,EQ,,,,,"
    "NIP IND ETF NIFTY BEES,285.00,288.00,284.00,286.54,286.50,285.10,,286.54,,,1,1,1,F1,1,,,,,"
)


def test_etfs_in_the_price_file_become_searchable_stocks(db_session: Session) -> None:
    from tests.price_fakes import read

    a = user(db_session, "a@example.com")
    etf = link(db_session, a, "stock", "NIFTYBEES", symbol="NIFTYBEES")
    bhav = read("bhavcopy.csv").rstrip("\n") + "\n" + ETF_ROW + "\n"
    fetcher = FakeFetcher(texts={"bhavcopy.csv": bhav})

    report = run_nightly(db_session, fetcher, TODAY)

    assert report.failed == {}
    row = market(db_session, "stock", "NIFTYBEES")
    assert (row.name, row.isin, row.price) == (
        "NIP IND ETF NIFTY BEES",
        "INF204KB14I2",
        Decimal("286.5400"),
    )
    assert [r.price for r in rows(db_session, etf)] == [Decimal("286.5400")]
    # A stock on NSE's equity list keeps the list's name, not the price file's short one.
    assert market(db_session, "stock", STOCK_CODE).name == "Reliance Industries Limited"
